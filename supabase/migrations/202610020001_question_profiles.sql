-- Additive migration: existing rooms have no profile snapshot and retain legacy rules.
CREATE TABLE public.question_profiles (
 id bigint PRIMARY KEY CHECK(id=1), profile_json text NOT NULL CHECK(json_valid(profile_json)),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0), updated_at_ms bigint NOT NULL, last_command_id text
);
CREATE TABLE public.room_question_profiles (
 room_id text PRIMARY KEY REFERENCES public.rooms(id) ON DELETE CASCADE,
 profile_json text NOT NULL CHECK(json_valid(profile_json)), profile_revision bigint NOT NULL CHECK(profile_revision>=0)
);
CREATE TABLE public.question_profile_receipts (
 teacher_id text NOT NULL, request_id text NOT NULL, body_hash text NOT NULL,
 result_json text NOT NULL CHECK(json_valid(result_json)), PRIMARY KEY(teacher_id,request_id)
);
ALTER TABLE public.question_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_question_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_profile_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.question_profiles,public.room_question_profiles,public.question_profile_receipts FROM PUBLIC,anon,authenticated;
