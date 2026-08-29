import { supabase } from '../lib/supabase.js';

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
    const { data: { user }, error } = await supabase.auth.getUser(token);

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