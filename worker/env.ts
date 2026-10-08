import type {AuthEnvironment} from './auth/types';
import type {PersistenceDatabase} from '../src/persistence/db';
import {fromD1} from '../src/persistence/db';
export type IndependentEnv=Env & {ROOMS:DurableObjectNamespace;APP_ORIGIN:string;GOOGLE_CLIENT_ID?:string;GOOGLE_CLIENT_SECRET?:string;MASTER_TEACHER_EMAIL?:string};
export function authEnvironment(env:IndependentEnv):AuthEnvironment{return {...env,DB:fromD1(env.DB as unknown as PersistenceDatabase)};}
