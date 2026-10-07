// Playwright MCP callback. Run against a local host in PREPARING with ready held.
async (page) => {
 let unblock,intercepted;const gate=new Promise(r=>unblock=r);const started=new Promise(r=>intercepted=r);
 let held=false;const dialogs=[];const onDialog=async d=>{dialogs.push(d.message());await d.dismiss();};page.on('dialog',onDialog);
 await page.route('**/api/rooms/*/state',async route=>{
  if(held){await route.continue();return;}held=true;intercepted();await gate;
  const response=await route.fetch();await route.fulfill({response});
 });
 await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('No state poll')),6000))]);
 const cancelled=page.waitForResponse(r=>r.url().includes('/cancel-preparation')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'準備を取り消す',exact:true}).click();await cancelled;
 await new Promise(r=>setTimeout(r,100));unblock();
 await page.getByRole('button',{name:'問題を準備して開始',exact:true}).waitFor({timeout:10000});
 await new Promise(r=>setTimeout(r,300));await page.unroute('**/api/rooms/*/state');page.off('dialog',onDialog);
 if(dialogs.length)throw new Error('Cancellation produced a false failure: '+dialogs.join(','));
 return {dialogs,text:await page.locator('body').innerText()};
}
