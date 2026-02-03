/**
 * Auth and identity helpers for the extension.
 * - Anonymous ID: persisted in local storage for usage limits when not logged in.
 * - Session: Supabase session (access_token) stored in local storage when logged in.
 */

const ANON_ID_KEY = 'rewordly_anonymous_id';
export const SESSION_KEY = 'rewordly_session';

function generateId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface StoredSession {
  access_token: string;
  expires_at?: number;
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
 * Get stored session (access_token) if any.
 */
export async function getSession(): Promise<StoredSession | null> {
  const result = await chrome.storage.local.get([SESSION_KEY]);
  const raw = result[SESSION_KEY];
  if (!raw || typeof raw !== 'object' || !(raw as StoredSession).access_token) {
    return null;
  }
  return raw as StoredSession;
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
