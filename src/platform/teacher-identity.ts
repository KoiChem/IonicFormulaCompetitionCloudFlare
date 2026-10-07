import "./server-only";

export type TeacherIdentity = {
  readonly id: string;
  readonly email: string;
};

export interface TeacherIdentityProvider {
  getVerifiedIdentity(request: Request): Promise<TeacherIdentity | null>;
}

export class TeacherIdentityError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    readonly code: "authentication_required" | "teacher_forbidden" | "identity_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "TeacherIdentityError";
  }
}

export function normalizeTeacherEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

/**
 * Production deliberately fails closed until the Sites runtime supplies a
 * server-side verified identity adapter. Request headers are not read here:
 * without a documented trusted proxy boundary they are client-controlled.
 */
export const unavailableTeacherIdentityProvider: TeacherIdentityProvider = {
  async getVerifiedIdentity() {
    throw new TeacherIdentityError(
      503,
      "identity_unavailable",
      "教員認証を利用できません",
    );
  },
};

export async function requireVerifiedTeacher(
  request: Request,
  provider: TeacherIdentityProvider,
): Promise<TeacherIdentity> {
  let identity: TeacherIdentity | null;
  try {
    identity = await provider.getVerifiedIdentity(request);
  } catch (error) {
    if (error instanceof TeacherIdentityError) throw error;
    throw new TeacherIdentityError(503, "identity_unavailable", "教員認証を利用できません");
  }
  if (!identity || !identity.id.trim() || !identity.email.trim()) {
    throw new TeacherIdentityError(401, "authentication_required", "ログインが必要です");
  }

  const email = normalizeTeacherEmail(identity.email);
  return { id: identity.id.trim(), email };
}

export async function requireTeacher(request: Request, provider: TeacherIdentityProvider, allowedEmails: readonly string[]): Promise<TeacherIdentity> {
  const identity = await requireVerifiedTeacher(request, provider);
  const email = identity.email;
  const normalizedAllowlist = new Set(allowedEmails.map(normalizeTeacherEmail).filter(Boolean));
  if (!normalizedAllowlist.has(email)) {
    throw new TeacherIdentityError(403, "teacher_forbidden", "教員として許可されていません");
  }
  return { id: identity.id.trim(), email };
}
