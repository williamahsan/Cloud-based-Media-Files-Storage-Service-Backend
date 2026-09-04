import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { uploadSingle } from '../middleware/uploadMiddleware.js';

const router = express.Router();
const BUCKET_NAME = process.env.SUPABASE_STORAGE_BUCKET || 'drive';

// POST /api/files/upload
router.post('/upload', requireAuth, uploadSingle, async (req, res) => {
  try {
    const file = req.file;
    const userId = req.user.userId;
    const folderId = req.body.folderId || null;

    if (!file) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'No file provided in the request' }
      });
    }

    // 1. Calculate file checksum (SHA-256)
    const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');

    // 2. Generate a unique storage key path: tenants/{userId}/files/{uuid}-{filename}
    const fileUuid = crypto.randomUUID();
    const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storageKey = `tenants/${userId}/files/${fileUuid}-${sanitizedFilename}`;

    // 3. Upload file buffer to Supabase Storage
    const { data: storageData, error: storageError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(storageKey, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (storageError) {
      return res.status(500).json({
        error: { code: 'STORAGE_ERROR', message: storageError.message }
      });
    }

    // 4. Save file metadata into the PostgreSQL "files" table
    const { data: fileRecord, error: dbError } = await supabase
      .from('files')
      .insert([
        {
          id: fileUuid,
          name: file.originalname,
          mime_type: file.mimetype,
          size_bytes: file.size,
          storage_key: storageKey,
          owner_id: userId,
          folder_id: folderId,
          checksum: checksum,
          is_deleted: false
        }
      ])
      .select()
      .single();

    if (dbError) {
      // Rollback: Remove uploaded file from storage if DB insertion fails
      await supabase.storage.from(BUCKET_NAME).remove([storageKey]);
      throw dbError;
    }

    // 5. Log activity record
    await supabase.from('activities').insert([
      {
        actor_id: userId,
        action: 'upload',
        resource_type: 'file',
        resource_id: fileRecord.id,
        context: { name: fileRecord.name, size: fileRecord.size_bytes }
      }
    ]);

    res.status(201).json({
      message: 'File uploaded successfully',
      file: fileRecord
    });
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: error.message }
    });
  }
});

// GET /api/files/recent - Fetch recently modified or uploaded files
router.get('/recent', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const limit = parseInt(req.query.limit, 10) || 30;    

    const { data: files, error } = await supabase
      .from('files')
      .select('*')
      .eq('owner_id', userId)
      .eq('is_deleted', false)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({ files: files || [] });
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: error.message }
    });
  }
});

// PATCH /api/files/:id - Rename or Move file
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const fileId = req.params.id;
    const userId = req.user.userId;
    const { name, folderId } = req.body;

    const updates = {};
    if (name) updates.name = name.trim();
    if (folderId !== undefined) updates.folder_id = folderId || null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'No fields provided to update' } });
    }

    const { data: file, error } = await supabase
      .from('files')
      .update(updates)
      .eq('id', fileId)
      .eq('owner_id', userId)
      .select()
      .single();

    if (error || !file) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    }

    // Log activity
    await supabase.from('activities').insert([
      {
        actor_id: userId,
        action: name ? 'rename' : 'move',
        resource_type: 'file',
        resource_id: fileId,
        context: updates
      }
    ]);

    res.json({ message: 'File updated successfully', file });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// DELETE /api/files/:id - Soft delete file
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const fileId = req.params.id;
    const userId = req.user.userId;

    const { data: file, error } = await supabase
      .from('files')
      .update({ is_deleted: true, updated_at: new Date().toISOString() })
      .eq('id', fileId)
      .eq('owner_id', userId)
      .select()
      .single();

    if (error || !file) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found or already deleted' } });
    }

    // Log activity
    await supabase.from('activities').insert([
      {
        actor_id: userId,
        action: 'delete',
        resource_type: 'file',
        resource_id: fileId,
        context: { name: file.name }
      }
    ]);

    res.json({ message: 'File moved to Trash', fileId });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// GET /api/files/:id - Fetch file details & short-lived signed download URL
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const fileId = req.params.id;
    const userId = req.user.userId;

    // 1. Fetch file record
    const { data: file, error } = await supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .eq('is_deleted', false)
      .single();

    if (error || !file) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    }

    // 2. Check ACL: user must be Owner OR have a row in `shares`
    let hasAccess = file.owner_id === userId;

    if (!hasAccess) {
      const { data: share } = await supabase
        .from('shares')
        .select('role')
        .eq('resource_type', 'file')
        .eq('resource_id', fileId)
        .eq('grantee_user_id', userId)
        .single();

      if (share) hasAccess = true;
    }

    if (!hasAccess) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied to this file' } });
    }

    // 3. Generate 60-second signed URL for secure download
    const { data: signedData, error: signErr } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(file.storage_key, 60, {
        download: file.name
      });

    if (signErr) throw signErr;

    // 4. Log download activity
    await supabase.from('activities').insert([
      {
        actor_id: userId,
        action: 'download',
        resource_type: 'file',
        resource_id: file.id,
        context: { name: file.name }
      }
    ]);

    res.json({
      file,
      signedUrl: signedData.signedUrl
    });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 1. POST /api/files/:id/version - Upload a new version of an existing file
router.post('/:id/version', requireAuth, uploadSingle, async (req, res) => {
  try {
    const fileId = req.params.id;
    const file = req.file;
    const userId = req.user.userId;

    if (!file) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'No file provided' } });
    }

    // Verify ownership
    const { data: existingFile, error: fetchErr } = await supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .eq('owner_id', userId)
      .eq('is_deleted', false)
      .single();

    if (fetchErr || !existingFile) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    }

    // Determine current version count
    const { count } = await supabase
      .from('file_versions')
      .select('*', { count: 'exact', head: true })
      .eq('file_id', fileId);

    const nextVersionNumber = (count || 0) + 1;

    // Archive current file state into file_versions
    await supabase.from('file_versions').insert([
      {
        file_id: fileId,
        version_number: nextVersionNumber,
        storage_key: existingFile.storage_key,
        size_bytes: existingFile.size_bytes,
        checksum: existingFile.checksum
      }
    ]);

    // Upload new file to Supabase Storage
    const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const newStorageKey = `tenants/${userId}/files/${crypto.randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

    const { error: storageErr } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(newStorageKey, file.buffer, { contentType: file.mimetype });

    if (storageErr) throw storageErr;

    // Update the base file record
    const { data: updatedFile, error: updateErr } = await supabase
      .from('files')
      .update({
        storage_key: newStorageKey,
        size_bytes: file.size,
        mime_type: file.mimetype,
        checksum,
        updated_at: new Date().toISOString()
      })
      .eq('id', fileId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    res.json({ message: 'New version uploaded successfully', file: updatedFile });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 2. GET /api/files/:id/versions - List version history
router.get('/:id/versions', requireAuth, async (req, res) => {
  try {
    const fileId = req.params.id;
    const userId = req.user.userId;

    const { data: versions, error } = await supabase
      .from('file_versions')
      .select('*')
      .eq('file_id', fileId)
      .order('version_number', { ascending: false });

    if (error) throw error;

    res.json({ versions: versions || [] });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 3. POST /api/files/:id/revert - Revert file to a previous version
router.post('/:id/revert', requireAuth, async (req, res) => {
  try {
    const fileId = req.params.id;
    const { versionId } = req.body;
    const userId = req.user.userId;

    const { data: targetVersion, error: vErr } = await supabase
      .from('file_versions')
      .select('*')
      .eq('id', versionId)
      .eq('file_id', fileId)
      .single();

    if (vErr || !targetVersion) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Version not found' } });
    }

    const { data: updatedFile, error: updateErr } = await supabase
      .from('files')
      .update({
        storage_key: targetVersion.storage_key,
        size_bytes: targetVersion.size_bytes,
        checksum: targetVersion.checksum,
        updated_at: new Date().toISOString()
      })
      .eq('id', fileId)
      .eq('owner_id', userId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    res.json({ message: 'File reverted successfully', file: updatedFile });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

export default router;