/**
 * Auth and identity helpers for the extension.
 * - Anonymous ID: persisted in local storage for usage limits when not logged in.
 * - Session: Supabase session stored in local storage when logged in.
 *   Silent token refresh: if access_token is expiring within REFRESH_THRESHOLD_SEC,
 *   getSession() will attempt a background refresh before returning.
 */

import { API_BASE } from './config';

const ANON_ID_KEY = 'rewordly_anonymous_id';
export const SESSION_KEY = 'rewordly_session';

/** Refresh token if fewer than this many seconds remain. */
const REFRESH_THRESHOLD_SEC = 300; // 5 minutes

function generateId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface StoredSession {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // Unix timestamp (seconds)
}

/**
 * Get or create a persistent anonymous ID (for usage tracking when not logged in).
 */
export async function getAnonymousId(): Promise<string> {
  const result = await chrome.storage.local.get([ANON_ID_KEY]);
  let id = result[ANON_ID_KEY] as string | undefined;
  if (!id) {
    id = generateId();
    await chrome.storage.local.set({ [ANON_ID_KEY]: id });
  }
  return id;
}

/**
 * Get stored session, silently refreshing it when the access_token is close to expiry.
 */
export async function getSession(): Promise<StoredSession | null> {
  const result = await chrome.storage.local.get([SESSION_KEY]);
  const raw = result[SESSION_KEY];
  if (!raw || typeof raw !== 'object' || !(raw as StoredSession).access_token) {
    return null;
  }
  const session = raw as StoredSession;

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresSoon =
    session.expires_at !== undefined && session.expires_at - nowSec < REFRESH_THRESHOLD_SEC;

  if (expiresSoon && session.refresh_token) {
    const refreshed = await refreshSession(session.refresh_token);
    if (refreshed) return refreshed;
    // If refresh failed but token isn't actually expired yet, still use it.
    if (session.expires_at !== undefined && session.expires_at > nowSec) {
      return session;
    }
    // Token is expired and refresh failed — clear session.
    await setSession(null);
    return null;
  }

  // Token has expired (no refresh_token available or unknown expiry).
  if (session.expires_at !== undefined && session.expires_at <= nowSec) {
    await setSession(null);
    return null;
  }

  return session;
}

/**
 * Attempt a silent token refresh via the web API.
 * Returns the new session on success, null on failure.
 */
async function refreshSession(refreshToken: string): Promise<StoredSession | null> {
  try {
    const response = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!response.ok) return null;
    const data = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
    };
    if (!data.access_token) return null;
    const newSession: StoredSession = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      ...(data.expires_at !== undefined ? { expires_at: data.expires_at } : {}),
    };
    await setSession(newSession);
    return newSession;
  } catch {
    return null;
  }
}

/**
 * Store session (call after Supabase sign-in).
 */
export async function setSession(session: StoredSession | null): Promise<void> {
  if (session) {
    await chrome.storage.local.set({ [SESSION_KEY]: session });
  } else {
    await chrome.storage.local.remove(SESSION_KEY);
  }
}

/**
 * Build headers for API requests.
 * Always sends X-Anonymous-Id so expired/invalid tokens still get per-device limits (anon:id).
 * When logged in, also sends Authorization.
 */
export async function getApiHeaders(): Promise<Record<string, string>> {
  const [session, anonId] = await Promise.all([getSession(), getAnonymousId()]);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Anonymous-Id': anonId,
  };
  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }
  return headers;
}
