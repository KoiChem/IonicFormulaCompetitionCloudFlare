import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ResultLoadPanel } from '../../src/features/results/ResultLoadPanel';

it('shows personal score for a mate participant while detail remains unavailable', () => {
 const html=renderToStaticMarkup(createElement(ResultLoadPanel, {state:{
  full:null,summary:{room:{id:'room',kind:'mate',state:'FINISHED'},own:{rank:2,correctCount:4,elapsedCs:1234,finishReason:'submitted'}},
  status:'retrying',error:'',requestId:null,canRetry:false,terminal:false,
 },retry:()=>{}}));
 expect(html).toContain('あなたの結果'); expect(html).toContain('2位'); expect(html).toContain('正解 4');
 expect(html).toContain('問題別結果を再取得しています'); expect(html).not.toContain('上位0位');
});
