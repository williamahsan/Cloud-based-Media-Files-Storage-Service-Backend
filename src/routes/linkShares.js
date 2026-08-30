import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();
const BUCKET_NAME = process.env.SUPABASE_STORAGE_BUCKET || 'drive';

// 1. POST /api/link-shares - Create or update public share link
router.post('/', requireAuth, async (req, res) => {
  try {
    const { resourceType, resourceId, expiresAt, password } = req.body;
    const userId = req.user.userId;

    if (!['file', 'folder'].includes(resourceType) || !resourceId) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'resourceType and resourceId are required' }
      });
    }

    // Generate cryptographically secure URL-safe token
    const token = crypto.randomBytes(16).toString('hex');
    let passwordHash = null;

    if (password && password.trim() !== '') {
      passwordHash = await bcrypt.hash(password, 10);
    }

    const { data: linkShare, error } = await supabase
      .from('link_shares')
      .insert([
        {
          resource_type: resourceType,
          resource_id: resourceId,
          token,
          role: 'viewer',
          password_hash: passwordHash,
          expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
          created_by: userId
        }
      ])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      message: 'Public link created successfully',
      link: {
        id: linkShare.id,
        token: linkShare.token,
        hasPassword: !!passwordHash,
        expiresAt: linkShare.expires_at,
        shareUrl: `${process.env.CORS_ORIGIN || 'http://localhost:3000'}/share/${linkShare.token}`
      }
    });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 2. GET /api/link-shares/:token - Resolve public link metadata & resource
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.query;

    const { data: linkShare, error } = await supabase
      .from('link_shares')
      .select('*')
      .eq('token', token)
      .single();

    if (error || !linkShare) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Shared link is invalid or expired' } });
    }

    // Check expiration
    if (linkShare.expires_at && new Date(linkShare.expires_at) < new Date()) {
      return res.status(410).json({ error: { code: 'GONE', message: 'Shared link has expired' } });
    }

    // Check password protection
    if (linkShare.password_hash) {
      if (!password) {
        return res.status(401).json({
          error: { code: 'PASSWORD_REQUIRED', message: 'This link requires a password to view' }
        });
      }
      const isMatch = await bcrypt.compare(password, linkShare.password_hash);
      if (!isMatch) {
        return res.status(403).json({ error: { code: 'INVALID_PASSWORD', message: 'Incorrect link password' } });
      }
    }

    // Fetch resource details and generate signed URL if it's a file
    if (linkShare.resource_type === 'file') {
      const { data: file, error: fileErr } = await supabase
        .from('files')
        .select('*')
        .eq('id', linkShare.resource_id)
        .eq('is_deleted', false)
        .single();

      if (fileErr || !file) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File no longer exists' } });
      }

      // Generate temporary signed URL (valid for 1 hour)
      const { data: signedData, error: signedErr } = await supabase.storage
        .from(BUCKET_NAME)
        .createSignedUrl(file.storage_key, 60 * 60);

      if (signedErr) throw signedErr;

      return res.json({ resourceType: 'file', file, downloadUrl: signedData.signedUrl });
    }

    // Return folder children if it's a folder
    const { data: folder } = await supabase
      .from('folders')
      .select('*')
      .eq('id', linkShare.resource_id)
      .eq('is_deleted', false)
      .single();

    const { data: files } = await supabase
      .from('files')
      .select('id, name, mime_type, size_bytes, created_at')
      .eq('folder_id', linkShare.resource_id)
      .eq('is_deleted', false);

    res.json({ resourceType: 'folder', folder, files: files || [] });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 3. DELETE /api/link-shares/:id - Disable public link
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const linkId = req.params.id;
    const userId = req.user.userId;

    const { error } = await supabase
      .from('link_shares')
      .delete()
      .eq('id', linkId)
      .eq('created_by', userId);

    if (error) throw error;

    res.json({ message: 'Public share link disabled' });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

export default router;