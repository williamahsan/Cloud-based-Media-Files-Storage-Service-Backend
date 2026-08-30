import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

// Helper to verify resource ownership
async function checkOwnership(resourceType, resourceId, userId) {
  const table = resourceType === 'file' ? 'files' : 'folders';
  const { data, error } = await supabase
    .from(table)
    .select('id, owner_id, name')
    .eq('id', resourceId)
    .single();

  if (error || !data || data.owner_id !== userId) {
    return null;
  }
  return data;
}

// 1. POST /api/shares - Share resource with another user by email
router.post('/', requireAuth, async (req, res) => {
  try {
    const { resourceType, resourceId, email, role = 'viewer' } = req.body;
    const userId = req.user.userId;

    if (!['file', 'folder'].includes(resourceType) || !resourceId || !email) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'resourceType, resourceId, and email are required' }
      });
    }

    if (!['viewer', 'editor'].includes(role)) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Role must be viewer or editor' }
      });
    }

    // 1. Verify owner permission
    const resource = await checkOwnership(resourceType, resourceId, userId);
    if (!resource) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Only the resource owner can grant permissions' }
      });
    }

    // 2. Lookup recipient profile by email
    const { data: recipient, error: userErr } = await supabase
      .from('profiles')
      .select('id, email, display_name')
      .eq('email', email.trim().toLowerCase())
      .single();

    if (userErr || !recipient) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Target user does not exist' }
      });
    }

    if (recipient.id === userId) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Cannot share resource with yourself' }
      });
    }

    // 3. Upsert share record
    const { data: share, error: shareErr } = await supabase
      .from('shares')
      .upsert(
        {
          resource_type: resourceType,
          resource_id: resourceId,
          grantee_user_id: recipient.id,
          role,
          created_by: userId
        },
        { onConflict: 'resource_type,resource_id,grantee_user_id' }
      )
      .select()
      .single();

    if (shareErr) throw shareErr;

    // 4. Log Activity
    await supabase.from('activities').insert([
      {
        actor_id: userId,
        action: 'share',
        resource_type: resourceType,
        resource_id: resourceId,
        context: { sharedWith: recipient.email, role }
      }
    ]);

    res.status(201).json({ message: 'Resource shared successfully', share });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 2. GET /api/shares/shared-with-me - List items shared with current user
router.get('/shared-with-me', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const { data: shares, error } = await supabase
      .from('shares')
      .select('*')
      .eq('grantee_user_id', userId);

    if (error) throw error;

    const fileIds = shares.filter(s => s.resource_type === 'file').map(s => s.resource_id);
    const folderIds = shares.filter(s => s.resource_type === 'folder').map(s => s.resource_id);

    // Fetch details of shared files and folders
    const { data: files } = fileIds.length
      ? await supabase.from('files').select('*').in('id', fileIds).eq('is_deleted', false)
      : { data: [] };

    const { data: folders } = folderIds.length
      ? await supabase.from('folders').select('*').in('id', folderIds).eq('is_deleted', false)
      : { data: [] };

    res.json({ sharedFiles: files || [], sharedFolders: folders || [], shares });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 3. GET /api/shares/:resourceType/:resourceId - List who has access
router.get('/:resourceType/:resourceId', requireAuth, async (req, res) => {
  try {
    const { resourceType, resourceId } = req.params;
    const userId = req.user.userId;

    const resource = await checkOwnership(resourceType, resourceId, userId);
    if (!resource) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Access denied' }
      });
    }

    const { data: shares, error } = await supabase
      .from('shares')
      .select('id, role, created_at, grantee:grantee_user_id(id, email, display_name, avatar_url)')
      .eq('resource_type', resourceType)
      .eq('resource_id', resourceId);

    if (error) throw error;

    res.json({ shares: shares || [] });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 4. DELETE /api/shares/:id - Revoke collaborator access
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const shareId = req.params.id;
    const userId = req.user.userId;

    // Verify requesting user created the share or is the owner
    const { data: share, error: fetchErr } = await supabase
      .from('shares')
      .select('*')
      .eq('id', shareId)
      .single();

    if (fetchErr || !share) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Share not found' } });
    }

    const resource = await checkOwnership(share.resource_type, share.resource_id, userId);
    if (!resource && share.created_by !== userId) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot revoke this permission' } });
    }

    const { error: deleteErr } = await supabase.from('shares').delete().eq('id', shareId);
    if (deleteErr) throw deleteErr;

    res.json({ message: 'Access revoked successfully' });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

export default router;