import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,test} from 'vitest';
import {ReopenSubmission} from '../src/ReopenSubmission';

test('submitted participant sees one clear edit action with its permanent caution',()=>{
 let calls=0;
 const html=renderToStaticMarkup(createElement(ReopenSubmission,{disabled:false,onConfirm:async()=>{calls++;}}));
 expect(html).toContain('解答を修正する');expect(html).toContain('class="primary-action reopen-request"');
 expect(html.match(/<button/g)).toHaveLength(1);expect(html).not.toContain('差し戻して修正する');
 expect(html).toContain('同点の場合の着順は、再提出の時刻で決まります。');
 const id=html.match(/aria-describedby="([^"]+)"/)![1];expect(html).toContain(`id="${id}"`);expect(calls).toBe(0);
});
test('deadline and unavailable connection disable the edit request',()=>{
 const html=renderToStaticMarkup(createElement(ReopenSubmission,{disabled:true,onConfirm:async()=>{}}));
 expect(html).toMatch(/<button[^>]*disabled=""/);expect(html).toContain('競技終了後は差し戻せません');
});
