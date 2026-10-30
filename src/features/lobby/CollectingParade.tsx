import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {colorForRunner} from './host-race-colors';
import './collecting-parade.css';

type Marcher = {id: string; nickname: string; joinedOrder?: number};
const armPoses = [
  'M273 455L142 555L111 508',
  'M273 455L220 550L170 520',
  'M273 455L405 560L374 598',
  'M273 455L330 540L305 595',
];
function MarchingFigure({phase, animated}: {phase: number; animated: boolean}) {
  const arm = (offset: number) => Array.from({length: 5}, (_, i) => armPoses[(i + offset) % 4]).join(';');
  const swing = (offset: number) => animated ? <animate attributeName="d" values={arm(offset)} dur="1.2s" begin={`${phase}s`} repeatCount="indefinite" calcMode="spline" keyTimes="0;.25;.5;.75;1" keySplines=".42 0 .58 1;.42 0 .58 1;.42 0 .58 1;.42 0 .58 1"/> : null;
  return <svg viewBox="40 110 420 780" aria-hidden="true"><g className="parade-body">
    <path className="parade-arm parade-arm-back" d={armPoses[0]}>{swing(0)}</path>
    <path className="parade-leg parade-leg-back" d="M273 647L273 842L211 842"/>
    <path d="M273 438V647"/>
    <path className="parade-arm parade-arm-front" d={armPoses[2]}>{swing(2)}</path>
    <path className="parade-leg parade-leg-front" d="M273 647L273 842L211 842"/>
    <circle cx="273" cy="286" r="130"/>
  </g></svg>;
}
export function paradeGeometry(width: number, count: number) {
  const distance = Math.max(width + 144, count * 160);
  return {distance, spacing: distance / Math.max(1, count), duration: distance / 80};
}
export function CollectingParade({roomId, participants}: {roomId: string; participants: readonly Marcher[]}) {
  const field = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [light, setLight] = useState(false);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    setWidth(element.clientWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try { setLight(localStorage.getItem('ionic-formula-competition:race-motion:v1') === 'light'); } catch {}
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const ordered = [...participants].sort((a, b) => (a.joinedOrder ?? 0) - (b.joinedOrder ?? 0));
  const {distance, spacing, duration} = paradeGeometry(width, ordered.length);
  return <section className={`collecting-parade ${light || reduced ? 'parade-light' : ''}`} aria-label="参加者の行進">
    <h1>結果を集計しています</h1>
    <div ref={field} className="parade-field" style={{'--parade-distance': `${distance}px`, '--parade-duration': `${duration}s`} as CSSProperties}>
      {ordered.map((person, index) => {
        const phase = -(index * .035 % 1) * 1.2;
        return <div className="parade-person" key={person.id} style={{color: colorForRunner(roomId, person.joinedOrder ?? index + 1), '--parade-delay': `${index * spacing / 80}s`, '--step-phase': `${phase}s`} as CSSProperties}>
          <MarchingFigure phase={phase} animated={!light && !reduced}/>
          <span title={person.nickname}>{person.nickname}</span>
        </div>;
      })}
    </div>
  </section>;
}
