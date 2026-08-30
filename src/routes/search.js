import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

// GET /api/search - Search across files and folders with pagination
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { q, type, limit = 20, offset = 0 } = req.query;

    // Base query targeting the unified search view[cite: 8]
    let query = supabase
      .from('searchable_items')
      .select('*', { count: 'exact' })
      .eq('owner_id', userId)
      .eq('is_deleted', false);

    // 1. Apply Full-Text / Fuzzy Search
    // Supabase's .ilike leverages the pg_trgm GIN index defined in the schema[cite: 7, 8]
    if (q && q.trim() !== '') {
      query = query.ilike('name', `%${q.trim()}%`);
    }

    // 2. Optional Type Filtering (file or folder)
    if (type && ['file', 'folder'].includes(type)) {
      query = query.eq('resource_type', type);
    }

    // 3. Apply Pagination & Lazy Loading Limits
    const parsedLimit = parseInt(limit, 10);
    const parsedOffset = parseInt(offset, 10);
    
    query = query
      .order('updated_at', { ascending: false })
      .range(parsedOffset, parsedOffset + parsedLimit - 1);

    const { data: results, count, error } = await query;

    if (error) throw error;

    res.json({
      results: results || [],
      pagination: {
        total: count,
        limit: parsedLimit,
        offset: parsedOffset,
        hasNextPage: parsedOffset + parsedLimit < count
      }
    });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
  }
});

export default router;