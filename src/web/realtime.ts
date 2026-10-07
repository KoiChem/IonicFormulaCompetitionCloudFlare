import { useEffect, useState } from 'react';
import { getSupabaseClient, ensureSession } from './supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
export type RoomTopics={control:string;host:string|null;epoch:number;role:string};
export type RoomEvent={epoch:number;revision:number;roomRevision?:number;eventId:string;roomId:string;participants?:any[]};
export function useRoomRealtime(topics:RoomTopics|undefined,enabled:boolean,onEvent:(event:RoomEvent,kind:'control'|'host')=>void,onResync:()=>void){
  const [subscribed,setSubscribed]=useState(false);
  useEffect(()=>{
    if(!topics||!enabled){setSubscribed(false);return;}
    let active=true;const channels:RealtimeChannel[]=[];const revisions={control:0,host:0};
    const setup=async()=>{
      const client=getSupabaseClient();const session=await ensureSession();
      if(!active)return;
      await client.realtime.setAuth(session.access_token);
      for(const kind of ['control','host'] as const){
        const name=topics[kind];if(!name)continue;
        const channel=client.channel(name,{config:{private:true}})
          .on('broadcast',{event:kind==='host'?'host.progress':'room.changed'},({payload})=>{
            if(!active||payload.epoch!==topics.epoch||!Number.isSafeInteger(payload.revision)||payload.revision<=revisions[kind])return;
            revisions[kind]=payload.revision;onEvent(payload,kind);
          }).subscribe(status=>{
            if(!active)return;
            if(kind==='control')setSubscribed(status==='SUBSCRIBED');
            if(status==='SUBSCRIBED')onResync();
            if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')setSubscribed(false);
          });
        channels.push(channel);
      }
    };
    void setup().catch(()=>{if(active)setSubscribed(false);});
    const {data}=getSupabaseClient().auth.onAuthStateChange((_event,session)=>{
      if(active&&session)void getSupabaseClient().realtime.setAuth(session.access_token);
    });
    return()=>{active=false;setSubscribed(false);data.subscription.unsubscribe();for(const channel of channels)void getSupabaseClient().removeChannel(channel);};
  },[topics?.control,topics?.host,topics?.epoch,enabled,onEvent,onResync]);
  return subscribed;
}
