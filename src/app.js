import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import { supabase } from './lib/supabase.js';
import authRoutes from './routes/auth.js';

dotenv.config();

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRoutes);

// Health check and DB verification route
app.get('/health', async (req, res) => {
  const { data, error } = await supabase.from('users').select('*', { count: 'exact', head: true });
  
  if (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
  return res.json({ status: 'ok', database: 'connected' });
});

export default app;