import {useEffect,useState} from 'react';
import {TeacherClient} from './TeacherClient';
import {getAuthSession,beginGoogleLogin,logout} from '../../src/web/auth';
import {apiFetch} from '../../src/web/api';
import {appPath} from '../../src/web/routing';
export default function TeacherPage(){
 const [status,setStatus]=useState<'checking'|'signedout'|'allowed'|'forbidden'>('checking');const [error,setError]=useState(()=>location.hash.includes('authError=google')?'Googleログインを完了できませんでした。登録アカウントでやり直してください。':'');
 useEffect(()=>{let active=true;const check=async()=>{try{const session=await getAuthSession();if(!session.identity){if(active)setStatus('signedout');return;}const response=await apiFetch('/api/teacher/session'),body=await response.json();if(active){setStatus(response.ok?'allowed':'forbidden');setError(response.ok?'':body.error?.message??'教員として登録されていません');}}catch(reason){if(active){setStatus('signedout');setError(reason instanceof Error?reason.message:'認証を確認できません');}}};void check();window.addEventListener('ionic-auth-change',check);window.addEventListener('focus',check);window.addEventListener('storage',check);return()=>{active=false;window.removeEventListener('ionic-auth-change',check);window.removeEventListener('focus',check);window.removeEventListener('storage',check);};},[]);
 if(status==='allowed')return <><TeacherClient/><div className="page-shell"><button onClick={()=>void logout().catch(reason=>setError(reason.message))}>ログアウト</button>{error&&<p role="alert">{error}</p>}</div></>;
 return <main className="page-shell"><section className="panel wide"><p className="eyebrow">TEACHER</p><h1>教員用</h1>{status==='checking'?<p role="status">教員資格を確認しています…</p>:<><p>登録されたGoogleアカウントでログインしてください。</p><button className="primary-action" onClick={()=>beginGoogleLogin()}>Googleでログイン</button></>}{error&&<p role="alert" className="error">{error}</p>}<a href={appPath('/')}>ホームへ戻る</a></section></main>;
}
