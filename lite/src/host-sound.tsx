import {useEffect,useRef,useState} from 'react';
import {primeAudio,playCountdownTick} from '../../src/features/play/audio-feedback';
import {HostSoundGate} from './host-sound-model';
const KEY='ionic-lite:host-countdown-sound';
function saved(){try{return localStorage.getItem(KEY)!=='off';}catch{return true;}}
export function useHostSound(active:boolean,start:number|null|undefined,deadline:number|null|undefined,now:()=>number){
  const [enabled,setEnabled]=useState(saved),enabledRef=useRef(enabled),gate=useRef(new HostSoundGate());
  enabledRef.current=enabled;
  useEffect(()=>{
    if(!active||start==null||deadline==null)return;
    const sample=()=>{const cue=gate.current.observe(start,deadline,now(),enabledRef.current&&!document.hidden);if(cue==='tick')playCountdownTick('medium');if(cue==='boundary')playBoundary();};
    sample();if(now()>=deadline+1000)return;const timer=setInterval(()=>{sample();if(now()>=deadline+1000)clearInterval(timer);},100);return()=>clearInterval(timer);
  },[active,start,deadline,now]);
  const toggle=()=>{const next=!enabled;setEnabled(next);try{localStorage.setItem(KEY,next?'on':'off');}catch{}if(next)primeAudio('medium');};
  const prime=()=>{if(enabled)primeAudio('medium');};
  return {enabled,toggle,prime};
}
// The shared audio helper owns the browser-unlocked context.
import {playHostBoundary} from '../../src/features/play/audio-feedback';
function playBoundary(){playHostBoundary('medium');}
export function HostSoundButton({sound}:{sound:ReturnType<typeof useHostSound>}){return <button type="button" className="race-motion-toggle" aria-label="ホストのカウントダウン音" aria-pressed={sound.enabled} onClick={sound.toggle}>音 {sound.enabled?'あり':'なし'}</button>;}
