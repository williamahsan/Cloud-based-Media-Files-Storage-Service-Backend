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

export default router;