export type ServerConfig = {
  teacherAllowedEmails: readonly string[];
  masterTeacherEmail?: string;
};

export function getServerConfig(
  env: Record<string, string | undefined>,
): ServerConfig {
  const teacherAllowedEmails = [
    ...new Set(
      (env.TEACHER_ALLOWED_EMAILS ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];

  return { teacherAllowedEmails, masterTeacherEmail: (env.MASTER_TEACHER_EMAIL ?? "").normalize("NFKC").trim().toLowerCase() };
}
