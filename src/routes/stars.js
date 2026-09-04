import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

// GET /api/stars - List all starred files and folders for the authenticated user
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const { data: starredItems, error } = await supabase
      .from('stars')
      .select('resource_type, resource_id')
      .eq('user_id', userId);

    if (error) throw error;

    const fileIds = starredItems
      .filter((s) => s.resource_type === 'file')
      .map((s) => s.resource_id);

    const folderIds = starredItems
      .filter((s) => s.resource_type === 'folder')
      .map((s) => s.resource_id);

    // Fetch details of active starred files and folders
    const { data: files } = fileIds.length
      ? await supabase
          .from('files')
          .select('*')
          .in('id', fileIds)
          .eq('is_deleted', false)
      : { data: [] };

    const { data: folders } = folderIds.length
      ? await supabase
          .from('folders')
          .select('*')
          .in('id', folderIds)
          .eq('is_deleted', false)
      : { data: [] };

    res.json({
      files: files || [],
      folders: folders || []
    });
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: error.message }
    });
  }
});

// POST /api/stars/toggle - Add or remove an item from stars
router.post('/toggle', requireAuth, async (req, res) => {
  try {
    const { resourceType, resourceId } = req.body;
    const userId = req.user.userId;

    if (!['file', 'folder'].includes(resourceType) || !resourceId) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'resourceType and resourceId are required' }
      });
    }

    const { data: existing } = await supabase
      .from('stars')
      .select('*')
      .eq('user_id', userId)
      .eq('resource_type', resourceType)
      .eq('resource_id', resourceId)
      .single();

    if (existing) {
      await supabase
        .from('stars')
        .delete()
        .eq('user_id', userId)
        .eq('resource_type', resourceType)
        .eq('resource_id', resourceId);

      return res.json({ message: 'Item unstarred', isStarred: false });
    } else {
      await supabase.from('stars').insert([
        {
          user_id: userId,
          resource_type: resourceType,
          resource_id: resourceId
        }
      ]);

      return res.json({ message: 'Item starred', isStarred: true });
    }
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: error.message }
    });
  }
});

export default router;