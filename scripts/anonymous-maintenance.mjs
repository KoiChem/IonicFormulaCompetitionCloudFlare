// Read-only inventory. Never deletes Auth accounts.
import {execFileSync} from 'node:child_process';
const project=process.argv[2];
if(!/^[a-z]{20}$/.test(project??''))throw new Error('Usage: node scripts/anonymous-maintenance.mjs <project-ref>');
const query=`SELECT u.id, u.last_sign_in_at, u.created_at FROM auth.users u
 WHERE u.is_anonymous=true
 AND COALESCE(u.last_sign_in_at,u.created_at)<now()-interval '30 days'
 AND NOT EXISTS(SELECT 1 FROM auth.identities i WHERE i.user_id=u.id AND i.provider<>'anonymous')
 AND NOT EXISTS(SELECT 1 FROM public.app_teacher_bindings t WHERE t.uid=u.id)
 AND NOT EXISTS(SELECT 1 FROM public.app_memberships m JOIN public.rooms r ON r.id=m.room_id
  WHERE m.uid=u.id AND r.expires_at_ms>floor(extract(epoch FROM now())*1000)::bigint)
 ORDER BY u.created_at LIMIT 500`;
const result=execFileSync(process.execPath,['node_modules/supabase/dist/supabase.js','db','query','--linked','--project-ref',project,query,'--output-format','json'],{encoding:'utf8'});
const data=JSON.parse(result);console.log(JSON.stringify({mode:'read-only',project,candidates:data.rows??[],note:'Administrator must review before any irreversible deletion.'},null,2));
