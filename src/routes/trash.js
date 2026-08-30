import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();
const BUCKET_NAME = process.env.SUPABASE_STORAGE_BUCKET || 'drive';

// 1. GET /api/trash - List all soft-deleted files and folders
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const { data: deletedFolders, error: folderErr } = await supabase
      .from('folders')
      .select('*')
      .eq('owner_id', userId)
      .eq('is_deleted', true)
      .order('updated_at', { ascending: false });

    if (folderErr) throw folderErr;

    const { data: deletedFiles, error: fileErr } = await supabase
      .from('files')
      .select('*')
      .eq('owner_id', userId)
      .eq('is_deleted', true)
      .order('updated_at', { ascending: false });

    if (fileErr) throw fileErr;

    res.json({
      trash: {
        folders: deletedFolders || [],
        files: deletedFiles || []
      }
    });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 2. POST /api/trash/restore - Restore an item from Trash
router.post('/restore', requireAuth, async (req, res) => {
  try {
    const { resourceType, resourceId } = req.body;
    const userId = req.user.userId;

    if (!['file', 'folder'].includes(resourceType) || !resourceId) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'resourceType (file|folder) and resourceId are required' }
      });
    }

    const table = resourceType === 'file' ? 'files' : 'folders';

    const { data: restoredItem, error } = await supabase
      .from(table)
      .update({ is_deleted: false, updated_at: new Date().toISOString() })
      .eq('id', resourceId)
      .eq('owner_id', userId)
      .select()
      .single();

    if (error || !restoredItem) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found in Trash' } });
    }

    // If restoring a folder, restore its child files
    if (resourceType === 'folder') {
      await supabase
        .from('files')
        .update({ is_deleted: false, updated_at: new Date().toISOString() })
        .eq('folder_id', resourceId)
        .eq('owner_id', userId);
    }

    // Log Activity
    await supabase.from('activities').insert([
      {
        actor_id: userId,
        action: 'restore',
        resource_type: resourceType,
        resource_id: resourceId,
        context: { name: restoredItem.name }
      }
    ]);

    res.json({ message: `${resourceType} restored successfully`, item: restoredItem });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 3. DELETE /api/trash/purge - Permanently delete an item
router.delete('/purge', requireAuth, async (req, res) => {
  try {
    const { resourceType, resourceId } = req.body;
    const userId = req.user.userId;

    if (resourceType === 'file') {
      const { data: file, error: fetchErr } = await supabase
        .from('files')
        .select('storage_key')
        .eq('id', resourceId)
        .eq('owner_id', userId)
        .single();

      if (fetchErr || !file) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
      }

      // Remove from storage bucket
      await supabase.storage.from(BUCKET_NAME).remove([file.storage_key]);

      // Remove row from DB
      await supabase.from('files').delete().eq('id', resourceId);
    } else if (resourceType === 'folder') {
      await supabase.from('folders').delete().eq('id', resourceId).eq('owner_id', userId);
    }

    res.json({ message: `${resourceType} permanently deleted` });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

export default router;