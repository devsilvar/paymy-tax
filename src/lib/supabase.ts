import { createClient } from '@supabase/supabase-js';
import { config } from '@/config';
import logger from './logger';

/**
 * Supabase Admin Client (Service Role)
 *
 * Uses the service role key to bypass Row Level Security (RLS).
 * This should ONLY be used server-side for trusted operations.
 * Never expose the service role key to the client.
 */
export const supabaseAdmin = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

logger.info('Supabase admin client initialized');

export default supabaseAdmin;
