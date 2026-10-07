import { ensureSession, getSupabaseClient } from './supabase';
import { sessionRefresher } from './refresh-session';
const refreshSession=sessionRefresher(()=>getSupabaseClient().auth.refreshSession());
export function apiHeaders(sessionToken: string, supplied?: HeadersInit): Headers {
  const headers = new Headers(supplied);
  const participant = headers.get('authorization');
  if (participant) headers.set('x-participant-authorization', participant);
  headers.set('authorization', `Bearer ${sessionToken}`);
  return headers;
}
export type ApiFetchOptions = RequestInit & { onDispatch?: () => void };
export async function apiFetch(path: string, init: ApiFetchOptions = {}): Promise<Response> {
  if (!path.startsWith('/api/')) throw new Error('Invalid API path');
  const session = await ensureSession();
  const headers = apiHeaders(session.access_token, init.headers);
  headers.set('apikey', import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
  if(import.meta.env.VITE_SUPABASE_FUNCTION_REGION)headers.set('x-region',import.meta.env.VITE_SUPABASE_FUNCTION_REGION);
  const {onDispatch, ...requestInit}=init;
  onDispatch?.();
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/competition${path}`, { ...requestInit, headers });
  if (response.status === 401) await refreshSession();
  return response;
}
