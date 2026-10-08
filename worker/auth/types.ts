import type {PersistenceDatabase} from '../../src/persistence/db';
import type {TeacherIdentity} from '../../src/platform/teacher-identity';
export type AuthEnvironment={DB:PersistenceDatabase;GOOGLE_CLIENT_ID?:string;GOOGLE_CLIENT_SECRET?:string;MASTER_TEACHER_EMAIL?:string;APP_ORIGIN?:string};
export type AuthSessionView={identity:TeacherIdentity|null;csrfToken:string|null;expiresAtMs:number|null};
