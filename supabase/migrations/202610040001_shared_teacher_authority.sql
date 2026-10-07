-- Registered server callers only. The HMAC secret is an Edge secret, never a table value.
CREATE TABLE public.shared_teacher_callers (
  app_id text PRIMARY KEY CHECK(app_id ~ '^[a-z0-9-]{3,64}$'),
  auth_url text NOT NULL CHECK(auth_url ~ '^https://[^/?#]+$'),
  publishable_key text NOT NULL,
  secret_env_name text NOT NULL CHECK(secret_env_name ~ '^SHARED_TEACHER_[A-Z0-9_]+_HMAC_SECRET$'),
  enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE public.shared_teacher_requests (
  app_id text NOT NULL REFERENCES public.shared_teacher_callers(app_id),
  request_id text NOT NULL,
  issued_at_ms bigint NOT NULL,
  PRIMARY KEY(app_id,request_id)
);
CREATE INDEX shared_teacher_requests_age ON public.shared_teacher_requests(issued_at_ms);
ALTER TABLE public.shared_teacher_callers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_teacher_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shared_teacher_callers,public.shared_teacher_requests FROM PUBLIC,anon,authenticated;
