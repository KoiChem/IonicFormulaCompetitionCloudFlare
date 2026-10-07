-- Supabase default privileges may grant anon/authenticated directly; revoking
-- PUBLIC alone does not remove those grants. Scope this to our own tables.
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['command_receipts','creation_receipts','final_results','operation_attempts','participant_fields','participants',
    'room_questions','rooms','site_setting_receipts','site_settings','teacher_allowlist','v2_batch_receipts','v2_final_fields','v2_operations',
    'v2_participant_progress','v2_room_manifests','app_auth_config','app_teacher_bindings','app_memberships','app_room_topics','app_outbox',
    'app_broadcast_budget','app_audit','app_request_limits'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', name);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.json_valid(text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.app_prune_auxiliary() RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  DELETE FROM app_request_limits WHERE window_ms < floor(extract(epoch FROM clock_timestamp())*1000)::bigint-3600000;
  DELETE FROM app_audit WHERE at_ms < floor(extract(epoch FROM clock_timestamp())*1000)::bigint-604800000;
  DELETE FROM app_outbox WHERE room_id IN (SELECT id FROM rooms WHERE expires_at_ms <= floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
END $$;
REVOKE ALL ON FUNCTION public.app_prune_auxiliary() FROM PUBLIC,anon,authenticated;
-- API performs bounded expired room cleanup. Anonymous Auth users require the
-- separate administrator maintenance script, with activity and retention checks.
