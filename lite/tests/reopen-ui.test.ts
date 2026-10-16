import {expect,test} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ReopenSubmission} from '../src/ReopenSubmission';
test('submitted waiting offers a request and permanent caution without initially confirming',()=>{
 const html=renderToStaticMarkup(createElement(ReopenSubmission,{disabled:false,onConfirm:async()=>{throw new Error('must not send during render');}}));
 expect(html).toContain('差し戻しを希望する');expect(html).toContain('aria-expanded="false"');expect(html).toMatch(/aria-describedby="([^"]+)"/);const cautionId=html.match(/aria-describedby="([^"]+)"/)![1];expect(html).toContain(`id="${cautionId}"`);expect(html).toContain('差し戻すと提出済みの状態が解除されます。同点の場合の着順は、再提出の時刻で決まります。全員の提出が完了した後や、競技終了後は差し戻せません。');expect(html).not.toContain('role="alertdialog"');expect(html).not.toContain('差し戻して解答に戻る');
 expect(renderToStaticMarkup(createElement(ReopenSubmission,{disabled:true,onConfirm:async()=>{}}))).toContain('disabled=""');
});
