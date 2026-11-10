/**
 * Extension config. For production, API_BASE is rewordly.store.
 * Supabase keys are injected at build time from .env (see .env.example).
 */
declare const process: { env: Record<string, string | undefined> };

export const API_BASE =
  process.env['API_BASE_URL'] || 'https://rewordly.store';

export const SUPABASE_URL =
  process.env['SUPABASE_URL'] || '';

export const SUPABASE_ANON_KEY =
  process.env['SUPABASE_ANON_KEY'] || '';

export const AUTH_ENABLED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
