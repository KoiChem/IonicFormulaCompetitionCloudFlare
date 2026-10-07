import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
let client: SupabaseClient | undefined;
let sessionPromise: Promise<Session> | undefined;
export function isConfigured() { return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY); }
export function getSupabaseClient(): SupabaseClient {
  if (!isConfigured()) throw new Error('接続設定を準備中です。管理者にお知らせください。');
  return client ??= createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { flowType: 'pkce', detectSessionInUrl: false, storageKey: 'ionic-competition-github:auth' },
    realtime: { params: { eventsPerSecond: 5 } },
  });
}
export async function ensureSession(): Promise<Session> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (data.session) return data.session;
  if (!sessionPromise) sessionPromise = supabase.auth.signInAnonymously().then(({ data, error }) => {
    if (error || !data.session) throw error ?? new Error('参加資格を確認できません');
    return data.session;
  }).finally(() => { sessionPromise = undefined; });
  return sessionPromise;
}
export async function completeOAuth() {
  const code = new URLSearchParams(window.location.search).get('code');
  if (!code) return;
  const { error } = await getSupabaseClient().auth.exchangeCodeForSession(code);
  const target = sessionStorage.getItem('ionic-competition-github:return') ?? '/teacher';
  sessionStorage.removeItem('ionic-competition-github:return');
  history.replaceState(null, '', `${import.meta.env.BASE_URL}#${target.startsWith('/') && !target.startsWith('//') ? target : '/teacher'}`);
  if (error) throw new Error('Googleログインを完了できませんでした。もう一度お試しください。');
}
