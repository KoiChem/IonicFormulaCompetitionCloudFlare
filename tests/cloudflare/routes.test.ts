import {expect,it} from 'vitest';
import {resolveCompetitionRoute} from '../../src/platform/api-routes';
it('resolves public and room contracts without accepting suffixes or encoded separators',()=>{
 expect(resolveCompetitionRoute('/api/public-config','GET')).toMatchObject({kind:'top',name:'publicConfig'});
 expect(resolveCompetitionRoute('/api/rooms/room-1/operations','POST')).toMatchObject({kind:'room',name:'operations',publicId:'room-1'});
 expect(resolveCompetitionRoute('/api/rooms/room-1/state','POST')).toEqual({status:405});
 for(const path of ['/api/unknown','/api/rooms/x/state/extra','/api/rooms/x%2Fy/state','/api/rooms/%ZZ/state'])expect(resolveCompetitionRoute(path,'GET')).toEqual({status:404});
});
it('covers all existing top and room handler routes',()=>{
 for(const [path,method] of [['class-rooms','POST'],['mate-rooms','POST'],['teacher/session','GET'],['teacher/allowlist','POST'],['teacher/question-profile','PATCH'],['teacher/site-settings','PATCH'],['join-info','GET']])expect(resolveCompetitionRoute('/api/'+path,method)).toHaveProperty('name');
 for(const [path,method] of [['state','GET'],['join','POST'],['nickname','PATCH'],['settings','PATCH'],['start-status','GET'],['start','POST'],['manifest','GET'],['ready','POST'],['cancel-preparation','POST'],['operations','POST'],['writer','POST'],['cancel','POST'],['interrupt','POST'],['remove','POST'],['actions','POST'],['results','GET'],['result-summary','GET']])expect(resolveCompetitionRoute('/api/rooms/r/'+path,method)).toHaveProperty('name');
});
