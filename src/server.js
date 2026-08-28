import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { supabase } from './lib/supabase.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
app.use(express.json());

// Health check and DB verification route
app.get('/health', async (req, res) => {
  const { data, error } = await supabase.from('users').select('*', { count: 'exact', head: true });
  
  if (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
  return res.json({ status: 'ok', database: 'connected' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});