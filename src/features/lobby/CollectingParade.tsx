import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {colorForRunner} from './host-race-colors';
import './collecting-parade.css';
type Marcher={id:string;nickname:string;joinedOrder?:number};
export function paradeGeometry(width:number,count:number){const distance=Math.max(width+144,count*160);return {distance,spacing:distance/Math.max(1,count),duration:distance/80};}
export function CollectingParade({roomId,participants}:{roomId:string;participants:readonly Marcher[]}){
 const field=useRef<HTMLDivElement>(null),[width,setWidth]=useState(800),[light,setLight]=useState(false);
 useEffect(()=>{const element=field.current;if(!element)return;const observer=new ResizeObserver(()=>setWidth(element.clientWidth));setWidth(element.clientWidth);observer.observe(element);return()=>observer.disconnect();},[]);
 useEffect(()=>{try{setLight(localStorage.getItem('ionic-formula-competition:race-motion:v1')==='light');}catch{}},[]);
 const ordered=[...participants].sort((a,b)=>(a.joinedOrder??0)-(b.joinedOrder??0));
 const {distance,spacing,duration}=paradeGeometry(width,ordered.length);
 return <section className={`collecting-parade ${light?'parade-light':''}`} aria-label="参加者の行進"><h1>結果を集計しています</h1><div ref={field} className="parade-field" style={{'--parade-distance':`${distance}px`,'--parade-duration':`${duration}s`} as CSSProperties}>{ordered.map((person,index)=><div className="parade-person" key={person.id} style={{color:colorForRunner(roomId,person.joinedOrder??index+1),'--parade-delay':`${index*spacing/80}s`,'--step-phase':`${index%5*-.13}s`} as CSSProperties}><svg viewBox="0 0 100 140" aria-hidden="true"><g className="parade-body"><circle cx="50" cy="24" r="17"/><path d="M50 41V83"/><g className="parade-arm parade-arm-left"><path d="M50 51L29 67L19 51"/></g><g className="parade-arm parade-arm-right"><path d="M50 51L72 67L64 78"/></g><g className="parade-leg parade-leg-left"><path d="M50 83L27 104L17 89"/></g><g className="parade-leg parade-leg-right"><path d="M50 83L70 111L59 125"/></g></g></svg><span title={person.nickname}>{person.nickname}</span></div>)}</div></section>;
}
