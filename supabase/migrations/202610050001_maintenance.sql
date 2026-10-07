-- Private bounded maintenance lease and health record. No competition data reset.
CREATE TABLE public.app_maintenance (
 id integer PRIMARY KEY CHECK(id=1), lease_until_ms bigint NOT NULL DEFAULT 0,
 last_attempt_ms bigint NOT NULL DEFAULT 0,last_success_ms bigint NOT NULL DEFAULT 0
);
INSERT INTO public.app_maintenance(id) VALUES(1);
ALTER TABLE public.app_maintenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_maintenance FROM PUBLIC,anon,authenticated;
ALTER TABLE public.app_outbox ADD COLUMN queued_at_ms bigint NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
CREATE INDEX app_outbox_queued ON public.app_outbox(queued_at_ms);
ALTER TABLE public.app_outbox ADD COLUMN maintenance_attempt_ms bigint NOT NULL DEFAULT 0;
