import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

// 1. POST /api/folders - Create a folder
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, parentId } = req.body;
    const userId = req.user.userId;

    if (!name || name.trim() === '') {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Folder name is required' }
      });
    }

    const { data: folder, error } = await supabase
      .from('folders')
      .insert([
        {
          name: name.trim(),
          owner_id: userId,
          parent_id: parentId || null,
          is_deleted: false
        }
      ])
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          error: { code: 'CONFLICT', message: 'A folder with this name already exists in this directory' }
        });
      }
      throw error;
    }

    // Log Activity
    await supabase.from('activities').insert([
      {
        actor_id: userId,
        action: 'upload',
        resource_type: 'folder',
        resource_id: folder.id,
        context: { name: folder.name }
      }
    ]);

    res.status(201).json({ folder });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 2. GET /api/folders/:id - Get folder details, subfolders, files, and breadcrumb path
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const folderId = req.params.id;
    const userId = req.user.userId;
    const isRoot = folderId === 'root';

    let currentFolder = null;
    let breadcrumbs = [];

    if (!isRoot) {
      // Fetch folder metadata
      const { data: folder, error: folderErr } = await supabase
        .from('folders')
        .select('*')
        .eq('id', folderId)
        .eq('owner_id', userId)
        .eq('is_deleted', false)
        .single();

      if (folderErr || !folder) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Folder not found' } });
      }
      currentFolder = folder;

      // Construct breadcrumbs tree via loop/traversal
      let currentParentId = folder.parent_id;
      breadcrumbs.unshift({ id: folder.id, name: folder.name });

      while (currentParentId) {
        const { data: parent } = await supabase
          .from('folders')
          .select('id, name, parent_id')
          .eq('id', currentParentId)
          .single();

        if (!parent) break;
        breadcrumbs.unshift({ id: parent.id, name: parent.name });
        currentParentId = parent.parent_id;
      }
    }

    breadcrumbs.unshift({ id: 'root', name: 'My Files' });

    // Fetch immediate child folders
    const parentQuery = isRoot ? null : folderId;
    let folderQuery = supabase
      .from('folders')
      .select('*')
      .eq('owner_id', userId)
      .eq('is_deleted', false);

    folderQuery = parentQuery ? folderQuery.eq('parent_id', parentQuery) : folderQuery.is('parent_id', null);
    const { data: childFolders, error: childFoldersErr } = await folderQuery.order('name');

    if (childFoldersErr) throw childFoldersErr;

    // Fetch immediate child files
    let fileQuery = supabase
      .from('files')
      .select('*')
      .eq('owner_id', userId)
      .eq('is_deleted', false);

    fileQuery = parentQuery ? fileQuery.eq('folder_id', parentQuery) : fileQuery.is('folder_id', null);
    const { data: files, error: filesErr } = await fileQuery.order('name');

    if (filesErr) throw filesErr;

    res.json({
      folder: currentFolder || { id: 'root', name: 'Root' },
      breadcrumbs,
      children: {
        folders: childFolders || [],
        files: files || []
      }
    });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 3. PATCH /api/folders/:id - Rename or Move folder
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const folderId = req.params.id;
    const userId = req.user.userId;
    const { name, parentId } = req.body;

    const updates = {};
    if (name) updates.name = name.trim();
    if (parentId !== undefined) updates.parent_id = parentId || null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'No fields provided to update' } });
    }

    // Prevent moving folder into itself
    if (parentId === folderId) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Cannot move folder into itself' } });
    }

    const { data: folder, error } = await supabase
      .from('folders')
      .update(updates)
      .eq('id', folderId)
      .eq('owner_id', userId)
      .select()
      .single();

    if (error) throw error;

    // Log Activity
    await supabase.from('activities').insert([
      {
        actor_id: userId,
        action: name ? 'rename' : 'move',
        resource_type: 'folder',
        resource_id: folderId,
        context: updates
      }
    ]);

    res.json({ message: 'Folder updated successfully', folder });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

// 4. DELETE /api/folders/:id - Soft delete folder and cascade to inner items
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const folderId = req.params.id;
    const userId = req.user.userId;

    // Mark folder as deleted
    const { data: folder, error } = await supabase
      .from('folders')
      .update({ is_deleted: true, updated_at: new Date().toISOString() })
      .eq('id', folderId)
      .eq('owner_id', userId)
      .select()
      .single();

    if (error || !folder) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Folder not found or already deleted' } });
    }

    // Mark all direct child files as soft deleted
    await supabase
      .from('files')
      .update({ is_deleted: true, updated_at: new Date().toISOString() })
      .eq('folder_id', folderId)
      .eq('owner_id', userId);

    // Log activity
    await supabase.from('activities').insert([
      {
        actor_id: userId,
        action: 'delete',
        resource_type: 'folder',
        resource_id: folderId,
        context: { name: folder.name }
      }
    ]);

    res.json({ message: 'Folder moved to Trash', folderId });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

export default router;