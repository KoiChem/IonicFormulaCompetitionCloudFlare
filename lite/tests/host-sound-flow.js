async(page)=>{
 const reports=[];
 for(const port of [8791,8792]){
  const origin='http://localhost:'+port,browser=page.context().browser(),hc=await browser.newContext(),sc=await browser.newContext();
  try{
   await hc.addCookies([{name:port===8791?'__Host-ionic-lite-session':'__Host-alkane-lite-session',value:'A'.repeat(43),domain:'localhost',path:'/',secure:true,httpOnly:true,sameSite:'Lax'}]);
   await hc.addInitScript(()=>{
    window.__tones=[];window.__clockOffset=0;const raw=performance.now.bind(performance);performance.now=()=>raw()+window.__clockOffset;
    window.AudioContext=class{state='suspended';currentTime=0;destination={};resume(){this.state='running';return Promise.resolve();}createOscillator(){return {frequency:{setValueAtTime(v){window.__tones.push(v);}},connect(){},start(){},stop(){}};}createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}};}};
   });
   const host=await hc.newPage(),guest=await sc.newPage();await host.goto(origin+'/#/teacher');await host.getByRole('button',{name:'クラスルームを作る',exact:true}).click();await host.locator('.code strong').waitFor();const code=await host.locator('.code strong').innerText();
   await guest.goto(origin+'/#/join/'+code);await guest.getByLabel(/ニックネーム/).fill('音検証');await guest.getByRole('button',{name:'参加する',exact:true}).click();await host.getByText('音検証',{exact:true}).waitFor();await host.getByRole('button',{name:'問題を準備して開始',exact:true}).click();await host.waitForTimeout(6200);
   const start=await host.evaluate(()=>window.__tones.slice());if(JSON.stringify(start)!==JSON.stringify([880,880,880,880,880,1100]))throw Error('Unexpected start cues '+JSON.stringify(start));
   const credential=await host.evaluate(code=>JSON.parse(localStorage.getItem((location.port==='8791'?'ionic-lite':'alkane-lite')+':teacher:'+code)),code);
   const data=await (await hc.request.get(origin+'/api/rooms/'+code+'/state',{headers:{authorization:'Bearer '+credential.token}})).json();
   await host.evaluate(({deadline,serverNow})=>{window.__clockOffset=deadline-serverNow-10500;window.__tones=[];},{deadline:data.room.deadlineAtMs,serverNow:data.serverNow});await host.waitForTimeout(11500);
   const end=await host.evaluate(()=>window.__tones.slice());if(JSON.stringify(end)!==JSON.stringify([...Array(10).fill(880),1100]))throw Error('Unexpected end cues '+JSON.stringify(end));
   const layouts=[];for(const width of [320,390,768,1280]){await host.setViewportSize({width,height:844});const overflow=await host.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)throw Error('Host overflow');layouts.push({width,overflow});}
   await host.getByRole('button',{name:'ホストのカウントダウン音'}).click();const key=port===8791?'ionic-lite:host-countdown-sound':'alkane-lite:host-countdown-sound';if(await host.evaluate(key=>localStorage.getItem(key),key)!=='off')throw Error('Mute not saved');
   reports.push({port,start,end,layouts,muteSaved:true});
  }finally{await hc.close();await sc.close();}
 }
 return reports;
}
