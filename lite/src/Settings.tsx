import type {IonicFormulaGameSettings} from '../../src/games/ionic-formula/shared/types';
import {settingsSummary} from '../../src/features/setup/CompetitionSettingsForm';
function Choice<T extends string|number>({title,values,value,onChange,label}:{title:string;values:readonly T[];value:T;onChange(v:T):void;label(v:T):string}){
  return <fieldset><legend>{title}</legend><div className="choice-grid">{values.map(v=><button type="button" className="choice" key={v} aria-pressed={value===v} onClick={()=>onChange(v)}>{label(v)}</button>)}</div></fieldset>;
}
export function Settings({value,onChange}:{value:IonicFormulaGameSettings;onChange(v:IonicFormulaGameSettings):void}){
  const update=<K extends keyof IonicFormulaGameSettings>(key:K,next:IonicFormulaGameSettings[K])=>onChange({...value,[key]:next});
  return <div className="settings-form">
    <Choice title="問題数" values={[5,10,15] as const} value={value.questionCount} onChange={v=>update('questionCount',v)} label={v=>`${v}問`}/>
    <Choice title="制限時間" values={[3,4,5,6,7,8,9,10] as const} value={value.timeLimitMinutes} onChange={v=>update('timeLimitMinutes',v)} label={v=>`${v}分`}/>
    <Choice title="出題" values={['ion','compound'] as const} value={value.mode} onChange={v=>update('mode',v)} label={v=>v==='ion'?'イオン':'化合物'}/>
    <Choice title="難易度" values={['normal','hard','complex'] as const} value={value.complexOnly?'complex':value.difficulty} onChange={v=>onChange({...value,difficulty:v==='complex'?value.difficulty:v,complexOnly:v==='complex'})} label={v=>({normal:'やさしめ',hard:'ややむず',complex:'錯のみ'})[v]}/>
    <button type="button" className="choice" disabled={value.complexOnly} aria-pressed={value.complexOnly||value.complexEnabled===true} onClick={()=>update('complexEnabled',!value.complexEnabled)}>錯イオン {value.complexOnly||value.complexEnabled?'ON':'OFF'}</button>
    {value.mode==='ion'?<Choice title="答え方" values={['formula','name','random'] as const} value={value.ionAnswer} onChange={v=>update('ionAnswer',v)} label={v=>({formula:'イオン式',name:'イオン名',random:'式 or 名'})[v]}/>:<>
      <fieldset><legend>化合物の出題</legend><div className="choice-grid">{(['formula','name'] as const).map(key=><button type="button" className="choice" aria-pressed={value.compoundPrompts[key]} key={key} onClick={()=>{const next={...value.compoundPrompts,[key]:!value.compoundPrompts[key]};if(next.formula||next.name)update('compoundPrompts',next);}}>{key==='formula'?'イオン式':'イオン名'}</button>)}</div></fieldset>
      <Choice title="答え方" values={['formula','name','random','both'] as const} value={value.compoundAnswer} onChange={v=>update('compoundAnswer',v)} label={v=>({formula:'組成式',name:'化合物名',random:'式 or 名',both:'式 ＆ 名'})[v]}/>
    </>}
    <p className="settings-summary">{settingsSummary(value)}</p>
  </div>;
}
