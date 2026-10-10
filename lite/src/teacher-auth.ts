export type TeacherSession = {
  ready: boolean;
  identity: {id: string; email: string} | null;
  isMaster: boolean;
  csrfToken: string | null;
  expiresAtMs: number | null;
};
export async function readTeacherSession(): Promise<TeacherSession> {
  const response = await fetch('/api/auth/session', {cache: 'no-store'});
  if (!response.ok) throw new Error('ログイン状況を確認できません。再試行してください');
  return response.json();
}
export async function teacherMutation<T = unknown>(path: string, method: string, session: TeacherSession, body?: unknown): Promise<T> {
  const response = await fetch(path, {method, headers: {'content-type': 'application/json', 'x-competition-csrf': session.csrfToken ?? ''}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const data = await response.json() as {error?: string};
  if (!response.ok) throw Object.assign(new Error(data.error ?? '操作を確認できません'), {status: response.status});
  return data as T;
}
