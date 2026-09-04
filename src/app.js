import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import { supabase } from './lib/supabase.js';
import authRoutes from './routes/auth.js';
import fileRoutes from './routes/files.js';
import folderRoutes from './routes/folders.js';
import trashRoutes from './routes/trash.js';
import shareRoutes from './routes/shares.js';
import linkShareRoutes from './routes/linkShares.js';
import searchRoutes from './routes/search.js';
import starRoutes from './routes/stars.js';

dotenv.config();

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/trash', trashRoutes);
app.use('/api/shares', shareRoutes);
app.use('/api/link-shares', linkShareRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/stars', starRoutes);

// Health check and DB verification route
app.get('/health', async (req, res) => {
  const { data, error } = await supabase.from('users').select('*', { count: 'exact', head: true });
  
  if (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
  return res.json({ status: 'ok', database: 'connected' });
});

export default app;