import {expect,test} from 'vitest';
import {fixture,settings} from './helpers';
import {DEFAULT_QUESTION_PROFILE,questionProfileCatalog} from '../../src/games/ionic-formula/shared/question-profile';
test('a teacher-selected profile controls room generation and rejects invalid assignments',async()=>{
 const f=await fixture();try{
 const profile=structuredClone(DEFAULT_QUESTION_PROFILE);const allowed=['lithium','potassium','magnesium','calcium','aluminum'];for(const item of questionProfileCatalog().ions)profile.ionDifficulties[item.id]=allowed.includes(item.id)?'normal':'off';
 const response=await f.fetch('/api/rooms',{method:'POST',headers:{origin:'https://lite.test'},body:JSON.stringify({settings,profile})});expect(response.status).toBe(201);
 const {code}=await response.json() as any;const db=await f.storage(code);const rows=(await db.exec('SELECT questions FROM room')).rows;
 expect(JSON.parse(rows[0].questions).map((q:any)=>q.itemId).sort()).toEqual([...allowed].sort());
 profile.ionDifficulties.sodium='invalid' as any;const invalid=await f.fetch('/api/rooms',{method:'POST',headers:{origin:'https://lite.test'},body:JSON.stringify({settings,profile})});expect(invalid.status).toBe(400);
 }finally{await f.runtime.dispose();}
});
