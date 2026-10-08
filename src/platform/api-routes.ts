import type {createApiHandlers} from './http';
type HandlerName = keyof ReturnType<typeof createApiHandlers>;
export const topRoutes: Record<string, { method: string[]; name: HandlerName }> = {
  '/api/public-config': {method:['GET'],name:'publicConfig'},
  '/api/join-info': {method:['GET'],name:'joinInfo'},
  '/api/class-rooms': {method:['POST'],name:'createClassRoom'},
  '/api/mate-rooms': {method:['POST'],name:'createMateRoom'},
  '/api/teacher/session': {method:['GET'],name:'teacherSession'},
  '/api/teacher/allowlist': {method:['GET','POST'],name:'teacherAllowlist'},
  '/api/teacher/question-profile': {method:['GET','PATCH'],name:'teacherQuestionProfile'},
  '/api/teacher/site-settings': {method:['GET','PATCH'],name:'teacherSiteSettings'},
};
export const roomRoutes: Record<string, { method: string[]; name: HandlerName }> = {
  state:{method:['GET'],name:'state'},join:{method:['POST'],name:'joinRoom'},
  nickname:{method:['PATCH'],name:'nickname'},settings:{method:['PATCH'],name:'updateRoomSettings'},
  'start-status':{method:['GET'],name:'startStatus'},
  start:{method:['POST'],name:'startRoom'},manifest:{method:['GET'],name:'manifest'},ready:{method:['POST'],name:'ready'},
  'cancel-preparation':{method:['POST'],name:'cancelPreparation'},operations:{method:['POST'],name:'operations'},
  writer:{method:['POST'],name:'writer'},cancel:{method:['POST'],name:'cancelRoom'},interrupt:{method:['POST'],name:'interruptRoom'},
  remove:{method:['POST'],name:'removeParticipant'},actions:{method:['POST'],name:'actions'},
  results:{method:['GET'],name:'results'},'result-summary':{method:['GET'],name:'resultSummary'},
};
export type RouteResolution = {status:404|405}|{kind:'top'|'room';name:HandlerName;publicId?:string};
export function resolveCompetitionRoute(path:string,method:string):RouteResolution {
 const match=/^\/api\/rooms\/([A-Za-z0-9_-]{1,128})\/([a-z-]+)$/.exec(path);
 const route=topRoutes[path]??(match?roomRoutes[match[2]]:undefined);
 if(!route)return {status:404};
 if(!route.method.includes(method))return {status:405};
 return match?{kind:'room',name:route.name,publicId:match[1]}:{kind:'top',name:route.name};
}
