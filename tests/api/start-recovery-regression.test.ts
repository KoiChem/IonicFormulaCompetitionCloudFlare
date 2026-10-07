import {afterEach,it,expect} from 'vitest';
import {createApiTestContext,createClassRoom,joinClassRoom,apiRequest,SETTINGS} from './helpers';
import {createApiHandlers} from '../../src/platform/http';
const contexts:ReturnType<typeof createApiTestContext>[]=[];afterEach(()=>contexts.splice(0).forEach(c=>c.close()));
for(const delay of [29900,30000,30100])it(`last ready respects the preparation boundary at ${delay}ms`,async()=>{
 const c=createApiTestContext();contexts.push(c);const room=(await createClassRoom(c,crypto.randomUUID(),{...SETTINGS,gradingMode:'immediate'})).body.room;const participant=await joinClassRoom(c,room.id);
 const start=await c.handlers.startRoom(apiRequest(`/api/rooms/${room.id}/start`,{method:'POST',json:{requestId:crypto.randomUUID(),expectedRevision:1}}),{id:room.id});const prepared=await start.json();
 c.setNow(1000+delay);
 const manifest=await c.database.prepare('SELECT evaluator_version FROM v2_room_manifests LIMIT 1').first<{evaluator_version:string}>();
 const response=await c.handlers.ready(apiRequest(`/api/rooms/${room.id}/ready`,{method:'POST',token:participant.token,json:{manifestId:prepared.manifestId,preparationGeneration:1,evaluatorVersion:manifest!.evaluator_version}}),{id:room.id});
 const data=await response.json();expect(response.status).toBe(200);expect(data.state).toBe(delay<30000?'COUNTDOWN':'PREPARING');expect(data.preparationTimedOut).toBe(delay>=30000);
});
it('replays start receipt before consulting the question generator for v1 and v2',async()=>{
 for(const protocol of [1,2]){const c=createApiTestContext();contexts.push(c);const settings=protocol===2?{...SETTINGS,gradingMode:'immediate' as const}:SETTINGS;const room=(await createClassRoom(c,crypto.randomUUID(),settings)).body.room;await joinClassRoom(c,room.id);const body={requestId:crypto.randomUUID(),expectedRevision:1};const initial=await c.handlers.startRoom(apiRequest(`/api/rooms/${room.id}/start`,{method:'POST',json:body}),{id:room.id});expect(initial.status).toBe(200);
 const replayHandlers=createApiHandlers({...c.dependencies,random:()=>{throw new Error('Generator must not run on replay');}});const replay=await replayHandlers.startRoom(apiRequest(`/api/rooms/${room.id}/start`,{method:'POST',json:body}),{id:room.id});expect(replay.status).toBe(200);expect(await replay.json()).toEqual(await initial.json());
 }
});
