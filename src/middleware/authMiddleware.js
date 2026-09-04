import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// Dedicated, stateless client for user auth verification only
const authVerifier = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

export const requireAuth = async (req, res, next) => {
  // 1. Extract the token from the httpOnly cookie
  const token = req.cookies.accessToken;

  // 2. Block request if no token exists
  if (!token) {
    return res.status(401).json({ 
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' } 
    });
  }

  try {
    // 3. getUser() automatically verifies the RS256 signature and expiration
    const { data: { user }, error } = await authVerifier.auth.getUser(token);

    if (error || !user) {
      return res.status(403).json({ 
        error: { code: 'FORBIDDEN', message: 'Invalid or expired token' } 
      });
    }

    // Attach the user object to the request
    req.user = { userId: user.id, ...user }; 
    
    next();
  } catch (error) {
    return res.status(500).json({ 
      error: { code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Server error during authentication' } 
    });
  }
};