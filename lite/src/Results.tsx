import type {FormulaEntry} from '../../src/games/ionic-formula/shared/types';
import {QuestionView} from '../../src/games/ionic-formula/client/QuestionView';
import {formatCentiseconds} from '../../src/features/play/clock';
import {PodiumPlace} from '../../src/features/results/PodiumPlace';
import {settingsSummary} from '../../src/features/setup/CompetitionSettingsForm';
import type {Snapshot} from './protocol';
function Formula({text,charge}:{text:string;charge?:number}){return <span className="formula">{text.split(/(\d+)/).map((s,i)=>/^\d+$/.test(s)?<sub key={i}>{s}</sub>:<span key={i}>{s}</span>)}{charge?<sup>{Math.abs(charge)===1?'':Math.abs(charge)}{charge>0?'+':'−'}</sup>:null}</span>;}
function Answer({value,formula,charge}:{value:string|FormulaEntry;formula:boolean;charge?:number}){
  if(typeof value==='string'){
    if(!formula)return <>{value}</>;
    // Ion canonical strings already include their charge; render it as a superscript.
    const suffix=charge?`${Math.abs(charge)===1?'':Math.abs(charge)}${charge>0?'+':'-'}`:'';
    return <Formula text={suffix&&value.endsWith(suffix)?value.slice(0,-suffix.length):value} charge={charge}/>;
  }
  return <Formula text={value.tokens.join('')} charge={value.charge?value.charge.magnitude*(value.charge.sign==='+'?1:-1):undefined}/>;
}
export function Results({state}:{state:Snapshot}){
  const data=state.results!;
  return <main className="page-shell results-page lite-results"><section className="panel wide">
    <p className="eyebrow">IonicFormulaCompetition Lite</p><h1>{data.own?'あなたの結果':'クラスの結果'}</h1>
    {state.room.endReason==='interrupted'&&<p>先生が終了した時点の結果です。</p>}
    <p className="settings-summary">{settingsSummary(state.room.settings)}</p>
    {data.own&&<section className="own-result"><PodiumPlace rank={data.own.rank} name={data.own.nickname}>正解 {data.own.correctCount} / {state.room.maxScore}　時間 {formatCentiseconds(data.own.elapsedCs)}</PodiumPlace></section>}
    {data.ranking&&<><p>平均 {data.averageCorrectCount?.toFixed(1)}点 ／ {data.ranking.length}人</p><div className="lite-table-wrap"><table className="lite-ranking"><caption>全体の成績</caption><thead><tr><th scope="col">順位</th><th scope="col">ニックネーム</th><th scope="col">正解</th><th scope="col">時間</th></tr></thead><tbody>{data.ranking.map(p=><tr key={p.id}><td>{p.rank}</td><th scope="row">{p.nickname}</th><td>{p.correctCount} / {state.room.maxScore}</td><td>{formatCentiseconds(p.elapsedCs)}{!p.finished&&'（未完了）'}</td></tr>)}</tbody></table></div></>}
    {data.questions&&<section><h2>問題別の結果・復習</h2><ol className="review-list">{data.questions.map(q=><li key={q.id} className="review-card"><h3>第{q.ordinal+1}問</h3><QuestionView question={{...q,fields:q.fields.map(f=>({id:f.id,type:f.id})),progress:{resolvedFieldIds:[]}}}/>{q.fields.map(f=><div key={f.id} className="review-field"><p><strong className={`verdict ${f.state}`}>{({correct:'○ 正解',incorrect:'× 不正解',passed:'パス',unanswered:'未回答'})[f.state]}</strong>　正解：<Answer value={f.correctAnswer} formula={f.id==='formula'} charge={f.id==='formula'?f.ionCharge:undefined}/></p>{f.lastAnswer!==null&&<p>あなたの解答：<Answer value={f.lastAnswer} formula={f.id==='formula'}/></p>}</div>)}</li>)}</ol></section>}
    <p>閲覧期限：{new Date(state.room.expiresAtMs).toLocaleString('ja-JP')}</p><a className="primary-link" href="#/">ホームへ戻る</a>
  </section></main>;
}
