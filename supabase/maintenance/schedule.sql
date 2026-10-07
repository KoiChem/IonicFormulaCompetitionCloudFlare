-- Operational setup after migration, secret installation and Edge deployment.
-- Vault secret competition_maintenance_key must be installed privately first.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
SELECT cron.schedule('competition-maintenance', '* * * * *', $job$
 SELECT net.http_post(
  url := 'https://slktkbpvvsfpflnmpuvr.supabase.co/functions/v1/competition/maintenance',
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
   (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='competition_maintenance_key')),
  body := '{}'::jsonb, timeout_milliseconds := 55000
 );
$job$);
