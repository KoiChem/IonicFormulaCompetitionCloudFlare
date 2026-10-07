-- Edge-only commands. Never expose this schema in the Data API.
CREATE SCHEMA competition_private;
REVOKE ALL ON SCHEMA competition_private FROM PUBLIC, anon, authenticated;

CREATE FUNCTION competition_private.failure_v1(code text, status integer DEFAULT 409, message text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('status',status,'code',code,'message',message)
$$;

-- Notifications contain identifiers and revisions only. Upserts invalidate old leases.
CREATE FUNCTION competition_private.notify_v1(room_key text, host_changed boolean, control_changed boolean)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r public.rooms%ROWTYPE; t public.app_room_topics%ROWTYPE; k text; event_key text; rev bigint;
BEGIN
 IF NOT host_changed AND NOT control_changed THEN RETURN; END IF;
 SELECT * INTO STRICT r FROM public.rooms WHERE id=room_key;
 UPDATE public.app_room_topics SET progress_revision=progress_revision+1,control_revision=control_revision+1 WHERE room_id=room_key RETURNING * INTO STRICT t;
 FOREACH k IN ARRAY ARRAY['control','host'] LOOP
  IF (k='control' AND control_changed) OR (k='host' AND host_changed) THEN
   event_key:=gen_random_uuid()::text;rev:=CASE k WHEN 'host' THEN t.progress_revision ELSE t.control_revision END;
   INSERT INTO public.app_outbox(room_id,kind,revision,payload_json,event_id)
   VALUES(room_key,k,rev,jsonb_build_object('eventId',event_key,'roomId',r.public_id,'epoch',t.epoch,'revision',rev,'roomRevision',r.revision)::text,event_key)
   ON CONFLICT(room_id,kind) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json,event_id=excluded.event_id,lease_id=NULL,lease_until_ms=0,queued_at_ms=excluded.queued_at_ms;
  END IF;
 END LOOP;
END $$;

-- Existing UID-change trigger rotates the epoch and clears pending old-epoch rows.
CREATE FUNCTION competition_private.bind_v1(room_key text, participant_key text, verified_uid text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE old_uid text;
BEGIN
 SELECT uid INTO old_uid FROM public.app_memberships WHERE room_id=room_key AND participant_id=participant_key;
 IF old_uid=verified_uid THEN RETURN false; END IF;
 INSERT INTO public.app_memberships(room_id,participant_id,uid) VALUES(room_key,participant_key,verified_uid)
 ON CONFLICT(room_id,participant_id) DO UPDATE SET uid=excluded.uid;
 IF old_uid IS NOT NULL THEN
  INSERT INTO public.app_audit(actor_uid,event,room_id) VALUES(verified_uid,'participant_rebound',room_key);
  RETURN true;
 END IF;
 RETURN false;
END $$;

CREATE FUNCTION competition_private.join_room_v1(public_key text, verified_uid text, token_digest text, new_participant text,
 request_key text, body_digest text, display_name text, normalized_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r public.rooms%ROWTYPE; p public.participants%ROWTYPE; c public.command_receipts%ROWTYPE;
 at_ms bigint; actor text; marker text; n bigint; rebound boolean; replay boolean:=false; receipt jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('room:'||public_key,0));
 at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 SELECT * INTO r FROM public.rooms WHERE public_id=public_key;
 IF NOT FOUND THEN RETURN competition_private.failure_v1('not_found',404); END IF;
 IF r.expires_at_ms<=at_ms THEN RETURN competition_private.failure_v1('expired',410); END IF;
 IF r.game_version<>'2' THEN RETURN jsonb_build_object('unsupported',true); END IF;
 actor:='join:'||token_digest;
 SELECT * INTO c FROM public.command_receipts WHERE room_id=r.id AND actor_id=actor AND request_id=request_key AND expires_at_ms>at_ms;
 IF FOUND THEN
  IF c.body_hash<>body_digest THEN RETURN competition_private.failure_v1('request_id_reused'); END IF;
  receipt:=c.result_json::jsonb;
  SELECT * INTO p FROM public.participants WHERE room_id=r.id AND id=receipt->>'participantId' AND token_hash=token_digest;
  IF NOT FOUND OR p.status='REMOVED' THEN RETURN competition_private.failure_v1('not_authorized',403); END IF;
  replay:=true;
 ELSE
  IF r.state<>'WAITING' THEN RETURN competition_private.failure_v1('invalid_state'); END IF;
  IF EXISTS(SELECT 1 FROM public.v2_room_manifests WHERE room_id=r.id AND state<>'WAITING') THEN RETURN competition_private.failure_v1('stale_room_revision'); END IF;
  SELECT count(*) INTO n FROM public.participants WHERE room_id=r.id AND status<>'REMOVED';
  IF n>=(CASE r.kind WHEN 'class' THEN 42 ELSE 4 END) THEN RETURN competition_private.failure_v1('capacity'); END IF;
  IF EXISTS(SELECT 1 FROM public.participants WHERE room_id=r.id AND (token_hash=token_digest OR (status<>'REMOVED' AND nickname_key=normalized_name))) THEN RETURN competition_private.failure_v1('conflict',409,'同じ内容がすでに使用されています'); END IF;
  marker:=actor||':'||request_key||':'||gen_random_uuid()::text;
  UPDATE public.rooms SET revision=revision+1,last_command_id=marker WHERE id=r.id;
  SELECT count(*)+1 INTO n FROM public.participants WHERE room_id=r.id;
  INSERT INTO public.participants(room_id,id,token_hash,nickname,nickname_key,joined_at_ms,joined_order)
  VALUES(r.id,new_participant,token_digest,display_name,normalized_name,at_ms,n) RETURNING * INTO p;
  receipt:=jsonb_build_object('roomId',r.id,'participantId',p.id,'joinedOrder',p.joined_order,'participantRevision',p.revision);
  INSERT INTO public.command_receipts(room_id,actor_id,request_id,body_hash,result_code,result_json,processed_at_ms,expires_at_ms)
  VALUES(r.id,actor,request_key,body_digest,'joined',receipt::text,at_ms,r.expires_at_ms);
 END IF;
 INSERT INTO public.app_room_topics(room_id) VALUES(r.id) ON CONFLICT DO NOTHING;
 rebound:=competition_private.bind_v1(r.id,p.id,verified_uid);
 PERFORM competition_private.notify_v1(r.id,NOT replay OR rebound,rebound);
 RETURN jsonb_build_object('status',201,'body',jsonb_build_object('participant',jsonb_build_object('id',p.id,'nickname',display_name,'joinedOrder',(receipt->>'joinedOrder')::bigint,'revision',(receipt->>'participantRevision')::bigint)));
EXCEPTION WHEN unique_violation THEN
 -- This exception block rolls back every mutation in the function before returning.
 RETURN competition_private.failure_v1('conflict',409,'同じ内容がすでに使用されています');
END $$;

CREATE FUNCTION competition_private.mark_ready_v1(public_key text, verified_uid text, token_digest text, claimed_participant text,
 manifest_key text, evaluator_key text, generation bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r public.rooms%ROWTYPE; p public.participants%ROWTYPE; m public.v2_room_manifests%ROWTYPE;
 at_ms bigint; decision_ms bigint; participants bigint; ready bigint; changed_rows bigint; rebound boolean; transitioned boolean:=false;
 start_ms bigint; deadline_ms bigint; marker text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('room:'||public_key,0));
 at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 SELECT * INTO r FROM public.rooms WHERE public_id=public_key;
 IF NOT FOUND THEN RETURN competition_private.failure_v1('not_found',404); END IF;
 IF r.expires_at_ms<=at_ms THEN RETURN competition_private.failure_v1('expired',410); END IF;
 IF r.game_version<>'2' THEN RETURN jsonb_build_object('unsupported',true); END IF;
 IF r.state NOT IN ('WAITING','COUNTDOWN','RUNNING') THEN RETURN competition_private.failure_v1('invalid_state'); END IF;
 SELECT * INTO p FROM public.participants WHERE room_id=r.id AND token_hash=token_digest;
 IF NOT FOUND OR p.status='REMOVED' THEN RETURN competition_private.failure_v1('participant_forbidden',403,'参加者として確認できません'); END IF;
 IF claimed_participant IS NOT NULL AND claimed_participant<>'' AND claimed_participant<>p.id THEN RETURN competition_private.failure_v1('participant_forbidden',403,'別の参加者の情報は取得できません'); END IF;
 SELECT * INTO m FROM public.v2_room_manifests WHERE room_id=r.id;
 IF NOT FOUND THEN RETURN competition_private.failure_v1('not_found',404); END IF;
 IF m.manifest_id<>manifest_key OR m.evaluator_version<>evaluator_key OR m.preparation_generation<>generation THEN RETURN competition_private.failure_v1('invalid_state'); END IF;
 IF m.state NOT IN ('PREPARING','COUNTDOWN','RUNNING') THEN RETURN competition_private.failure_v1('invalid_state'); END IF;
 UPDATE public.v2_participant_progress SET ready_generation=generation WHERE room_id=r.id AND participant_id=p.id AND ready_generation<>generation AND p.status='ACTIVE';
 GET DIAGNOSTICS changed_rows=ROW_COUNT;
 SELECT count(*),count(*) FILTER(WHERE v.ready_generation=generation) INTO participants,ready FROM public.participants p0
 LEFT JOIN public.v2_participant_progress v ON v.room_id=p0.room_id AND v.participant_id=p0.id WHERE p0.room_id=r.id AND p0.status='ACTIVE';
 decision_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF participants>0 AND ready=participants AND m.state='PREPARING' AND r.state='WAITING' AND decision_ms<m.prepared_at_ms+30000 THEN
  start_ms:=decision_ms+5000;deadline_ms:=start_ms+(r.settings_json::jsonb->>'timeLimitMinutes')::bigint*60000;
  marker:='v2-ready:'||r.id||':'||generation||':'||gen_random_uuid()::text;
  UPDATE public.rooms SET state='COUNTDOWN',revision=revision+1,start_at_ms=start_ms,deadline_at_ms=deadline_ms,
   expires_at_ms=greatest(expires_at_ms,deadline_ms+CASE kind WHEN 'class' THEN 604800000 ELSE 86400000 END),last_command_id=marker WHERE id=r.id RETURNING * INTO r;
  UPDATE public.v2_room_manifests SET state='COUNTDOWN' WHERE room_id=r.id RETURNING * INTO m;
  UPDATE public.creation_receipts SET expires_at_ms=r.expires_at_ms WHERE room_id=r.id;
  UPDATE public.command_receipts SET expires_at_ms=r.expires_at_ms WHERE room_id=r.id;
  transitioned:=true;
 END IF;
 INSERT INTO public.app_room_topics(room_id) VALUES(r.id) ON CONFLICT DO NOTHING;
 rebound:=competition_private.bind_v1(r.id,p.id,verified_uid);
 PERFORM competition_private.notify_v1(r.id,changed_rows>0 OR transitioned OR rebound,transitioned OR rebound);
 RETURN jsonb_build_object('status',200,'body',jsonb_build_object('state',m.state,'readyCount',ready,'participantCount',participants,'startAtMs',r.start_at_ms,'deadlineAtMs',r.deadline_at_ms,'preparationTimedOut',m.state='PREPARING' AND decision_ms>=m.prepared_at_ms+30000));
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA competition_private FROM PUBLIC, anon, authenticated;
-- Functions run as the existing Edge database connection role; no browser grants.
