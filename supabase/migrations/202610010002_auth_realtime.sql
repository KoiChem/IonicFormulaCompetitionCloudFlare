-- Private application authorization tables; clients access only Edge API.
CREATE TABLE public.app_auth_config(id integer PRIMARY KEY CHECK(id = 1), master_email text NOT NULL);
CREATE TABLE public.app_teacher_bindings(uid text PRIMARY KEY, email text UNIQUE NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE TABLE public.app_memberships(room_id text NOT NULL, participant_id text NOT NULL, uid text NOT NULL,
  PRIMARY KEY(room_id,participant_id), FOREIGN KEY(room_id,participant_id) REFERENCES public.participants(room_id,id) ON DELETE CASCADE);
CREATE INDEX app_memberships_user ON public.app_memberships(uid,room_id);
CREATE TABLE public.app_room_topics(room_id text PRIMARY KEY REFERENCES public.rooms(id) ON DELETE CASCADE,
  epoch bigint NOT NULL DEFAULT 1, progress_revision bigint NOT NULL DEFAULT 0, control_revision bigint NOT NULL DEFAULT 0,
  sent_control_ms bigint NOT NULL DEFAULT 0, sent_progress_ms bigint NOT NULL DEFAULT 0);
CREATE TABLE public.app_outbox(room_id text NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('control','host')), revision bigint NOT NULL, payload_json text NOT NULL,
  event_id text NOT NULL, lease_id text, lease_until_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(room_id,kind));
CREATE TABLE public.app_broadcast_budget(id integer PRIMARY KEY CHECK(id=1), window_ms bigint NOT NULL DEFAULT 0, used bigint NOT NULL DEFAULT 0);
INSERT INTO public.app_broadcast_budget(id) VALUES(1);
CREATE TABLE public.app_audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_uid text, event text NOT NULL, room_id text,
  at_ms bigint NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
CREATE TABLE public.app_request_limits(bucket text PRIMARY KEY, window_ms bigint NOT NULL, count bigint NOT NULL);

ALTER TABLE public.app_auth_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_teacher_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_room_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_broadcast_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_request_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_auth_config,public.app_teacher_bindings,public.app_memberships,public.app_room_topics,
  public.app_outbox,public.app_broadcast_budget,public.app_audit,public.app_request_limits FROM PUBLIC;

-- Topics rotate when cached realtime permissions would otherwise remain valid.
CREATE FUNCTION public.app_rotate_topics() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'participants' THEN
    IF NEW.status = 'REMOVED' AND OLD.status <> 'REMOVED' THEN
      UPDATE app_room_topics SET epoch=epoch+1 WHERE room_id=NEW.room_id;
      DELETE FROM app_outbox WHERE room_id=NEW.room_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'app_memberships' THEN
    IF NEW.uid <> OLD.uid THEN
      UPDATE app_room_topics SET epoch=epoch+1 WHERE room_id=NEW.room_id;
      DELETE FROM app_outbox WHERE room_id=NEW.room_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'app_teacher_bindings' THEN
    IF OLD.active AND NOT NEW.active THEN
      UPDATE app_room_topics SET epoch=epoch+1 WHERE room_id IN (SELECT id FROM rooms WHERE owner_teacher_id=NEW.uid);
      DELETE FROM app_outbox WHERE room_id IN (SELECT id FROM rooms WHERE owner_teacher_id=NEW.uid);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_removed_topic AFTER UPDATE ON public.participants FOR EACH ROW EXECUTE FUNCTION public.app_rotate_topics();
CREATE TRIGGER app_rebind_topic AFTER UPDATE ON public.app_memberships FOR EACH ROW EXECUTE FUNCTION public.app_rotate_topics();
CREATE TRIGGER app_teacher_topic AFTER UPDATE ON public.app_teacher_bindings FOR EACH ROW EXECUTE FUNCTION public.app_rotate_topics();

CREATE FUNCTION public.app_sync_allowlist() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  UPDATE app_teacher_bindings SET active = email=(SELECT master_email FROM app_auth_config WHERE id=1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.emails_json::jsonb) e WHERE e=app_teacher_bindings.email);
  RETURN NEW;
END $$;
CREATE TRIGGER app_allowlist_sync AFTER INSERT OR UPDATE ON public.teacher_allowlist FOR EACH ROW EXECUTE FUNCTION public.app_sync_allowlist();

CREATE FUNCTION public.app_can_subscribe(topic text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (
    SELECT 1 FROM rooms r JOIN app_room_topics t ON t.room_id=r.id
    WHERE r.expires_at_ms > floor(extract(epoch FROM now())*1000)::bigint
      AND r.state NOT IN ('CANCELLED','EXPIRED')
      AND (
        (topic='room:'||r.public_id||':control:'||t.epoch AND (
          EXISTS(SELECT 1 FROM app_memberships m JOIN participants p ON p.room_id=m.room_id AND p.id=m.participant_id
            WHERE m.room_id=r.id AND m.uid=auth.uid()::text AND p.status<>'REMOVED')
          OR EXISTS(SELECT 1 FROM app_teacher_bindings b WHERE b.uid=auth.uid()::text AND b.uid=r.owner_teacher_id AND b.active)))
        OR (topic='room:'||r.public_id||':host:'||t.epoch AND (
          EXISTS(SELECT 1 FROM app_teacher_bindings b WHERE b.uid=auth.uid()::text AND b.uid=r.owner_teacher_id AND b.active)
          OR EXISTS(SELECT 1 FROM app_memberships m JOIN participants p ON p.room_id=m.room_id AND p.id=m.participant_id
            WHERE m.room_id=r.id AND m.uid=auth.uid()::text AND p.id=r.mate_host_id AND p.status<>'REMOVED')))
      )
  );
$$;
REVOKE ALL ON FUNCTION public.app_can_subscribe(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_can_subscribe(text) TO authenticated;
CREATE POLICY competition_private_receive ON realtime.messages FOR SELECT TO authenticated
  USING(extension='broadcast' AND public.app_can_subscribe(realtime.topic()));
-- No INSERT policy: application clients cannot emit trusted competition events.
REVOKE ALL ON FUNCTION public.app_rotate_topics(), public.app_sync_allowlist() FROM PUBLIC;
