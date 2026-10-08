import {useEffect,useState} from 'react';
import {connectRoomSocket,type RoomEvent} from './room-socket';
export type {RoomEvent} from './room-socket';
export type RoomTopics={control:string;host?:string|null;epoch:number;role:string};
export function useRoomRealtime(topics:RoomTopics|undefined,enabled:boolean,onEvent:(event:RoomEvent,kind:'control'|'host')=>void,onResync:()=>void,token?:string|null){
 const [subscribed,setSubscribed]=useState(false);
 useEffect(()=>{setSubscribed(false);if(!topics||!enabled)return;const roomId=topics.control.split(':')[1];return connectRoomSocket({roomId,token,onEvent,onResync,onStatus:setSubscribed});},[topics?.control,topics?.host,topics?.epoch,enabled,onEvent,onResync,token]);return subscribed;
}
