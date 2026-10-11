import {it,expect} from 'vitest';
import {fixture,settings,credentials} from './helpers';
it('creates retry-safe anonymous mates with a playing host and four-seat limit',async()=>{
 const f=await fixture(false);try{
 const input={kind:'mate',nickname:'作成者',settings,creationKey:'c'.repeat(64),token:'d'.repeat(64)};
 const create=()=>f.fetch('/api/rooms',{method:'POST',headers:{origin:'https://lite.test'},body:JSON.stringify(input)});
 const response=await create();expect(response.status).toBe(201);const room=await response.json() as any;
 expect(await (await create()).json()).toEqual(room);
 await f.fetch('/api/teacher/mate-setting',{method:'PUT',headers:f.teacherHeaders,body:JSON.stringify({enabled:false})});
 expect(await (await create()).json()).toEqual(room);
 await f.fetch('/api/teacher/mate-setting',{method:'PUT',headers:f.teacherHeaders,body:JSON.stringify({enabled:true})});
 const host=await f.connect(room.code);let s=await host.request({type:'hello',role:'mate-host',token:room.token,participantId:room.participantId});
 expect(s.state.own.nickname).toBe('作成者');expect(s.state.participants).toHaveLength(1);
 expect((await host.request({type:'start'})).type).toBe('error');
 expect((await host.request({type:'nickname',nickname:'作成者改名'})).state.own.nickname).toBe('作成者改名');
 expect((await host.request({type:'settings',settings:{...settings,timeLimitMinutes:4}})).state.room.settings.timeLimitMinutes).toBe(4);
 const guest=await f.connect(room.code),guestIdentity=credentials('友達');await guest.request(guestIdentity);expect((await guest.request({type:'start'})).code).toBe('forbidden');
 expect((await guest.request({type:'remove',participantId:room.participantId})).code).toBe('forbidden');
 expect((await host.request({type:'remove',participantId:guestIdentity.participantId})).state.participants).toHaveLength(1);
 const replacement=await f.connect(room.code);await replacement.request(credentials('友達再参加'));
 for(const name of ['三人目','四人目']){const c=await f.connect(room.code);expect((await c.request(credentials(name))).type).toBe('ack');}
 const fifth=await f.connect(room.code);expect((await fifth.request(credentials('五人目'))).code).toBe('room_full');
 expect((await host.request({type:'remove',participantId:room.participantId})).type).toBe('error');
 s=await host.request({type:'start'});expect(s.state.room.state).toBe('COUNTDOWN');expect(s.state.own).toBeDefined();
 const sql=await f.storage(room.code);await sql.exec('UPDATE room SET start_at=?,deadline_at=?',Date.now()-1000,Date.now()+60000);
 s=await host.request({type:'sync'});const q=s.state.question;expect((await host.request({type:'pass',seq:1,questionId:q.id,fieldId:q.fields[0].id})).type).toBe('ack');
 expect((await replacement.request({type:'sync'})).state.participants).toBeUndefined();
 const finished=await host.request({type:'finish'});expect(finished.state.room.endReason).toBe('interrupted');expect(finished.state.results.own.id).toBe(room.participantId);expect(finished.state.results.questions).toHaveLength(5);
 const spoof=await f.connect(room.code);expect((await spoof.request({type:'hello',role:'teacher',token:room.token})).type).toBe('error');
 }finally{await f.runtime.dispose();}
});
it('master can stop new anonymous mates and rejects untrusted origins',async()=>{
 const f=await fixture();try{
 expect((await (await f.fetch('/api/public-config')).json() as any).mateEnabled).toBe(true);
 expect((await f.fetch('/api/teacher/mate-setting',{method:'PUT',headers:f.teacherHeaders,body:JSON.stringify({enabled:false})})).status).toBe(200);
 expect((await f.fetch('/api/rooms',{method:'POST',headers:{origin:'https://lite.test'},body:JSON.stringify({kind:'mate',nickname:'生徒',settings,token:'d'.repeat(64),creationKey:'e'.repeat(64)})})).status).toBe(403);
 expect((await f.fetch('/api/rooms',{method:'POST',headers:{origin:'https://evil.test'},body:JSON.stringify({kind:'mate',settings})})).status).toBe(403);
 }finally{await f.runtime.dispose();}
});

it('limits anonymous creation attempts and rejects unauthenticated or CSRF-free setting changes',async()=>{
 const f=await fixture(false);try{
 expect((await f.fetch('/api/teacher/mate-setting',{method:'PUT',headers:{origin:'https://lite.test'},body:'{"enabled":false}'})).status).toBe(401);
 expect((await f.fetch('/api/teacher/mate-setting',{method:'PUT',headers:{origin:'https://lite.test',cookie:f.teacherHeaders.cookie},body:'{"enabled":false}'})).status).toBe(403);
 const input={kind:'mate',nickname:'回数確認',settings,token:'a'.repeat(64),creationKey:'b'.repeat(64)};
 for(let i=0;i<60;i++)expect((await f.fetch('/api/rooms',{method:'POST',headers:{origin:'https://lite.test'},body:JSON.stringify(input)})).status).toBe(201);
 expect((await f.fetch('/api/rooms',{method:'POST',headers:{origin:'https://lite.test'},body:JSON.stringify(input)})).status).toBe(429);
 }finally{await f.runtime.dispose();}
});
