async(page)=>{
 const origin='http://localhost:8791',reports=[];
 for(const grading of ['immediate','deferred']){
  const browser=page.context().browser(),hc=await browser.newContext(),gc=await browser.newContext();
  try{
   const host=await hc.newPage(),guest=await gc.newPage(),errors=[];host.on('pageerror',e=>errors.push(e.message));guest.on('pageerror',e=>errors.push(e.message));
   await host.goto(origin+'/#/mate/new');await host.getByLabel('ニックネーム（1〜16文字）').fill('メイト作成者');await host.getByRole('button',{name:'5問',exact:true}).click();await host.getByRole('button',{name:'イオン名',exact:true}).click();if(grading==='deferred')await host.getByRole('button',{name:'まとめて判定',exact:true}).click();
   await host.getByRole('button',{name:'メイトルームを作る',exact:true}).click();await host.locator('.code strong').waitFor();const code=await host.locator('.code strong').innerText();if(!await host.getByRole('button',{name:'問題を準備して開始',exact:true}).isDisabled())throw Error('Solo start');await host.reload();await host.locator('.code strong').waitFor();
   await guest.goto(origin+'/#/join/'+code);await guest.getByLabel('ニックネーム').fill('メイト参加者');await guest.getByRole('button',{name:'参加する',exact:true}).click();await host.getByText('メイト参加者',{exact:true}).waitFor();await host.getByRole('button',{name:'問題を準備して開始',exact:true}).click();
   for(const target of [host,guest]){
    if(grading==='immediate'){
     for(let i=1;i<=5;i++){await target.getByText('第'+i+'問 / 全5問',{exact:true}).waitFor();await target.getByRole('button',{name:'パス',exact:true}).click();}
     await target.getByRole('heading',{name:'全解答確認'}).waitFor();await target.getByRole('button',{name:'このまま提出',exact:true}).click();await target.getByRole('button',{name:'提出を確定する',exact:true}).click();
    }else{
     await target.locator('.question-navigation').waitFor();await target.getByRole('textbox',{name:'イオン名',exact:true}).fill('メイト下書き');await target.getByRole('button',{name:'全解答確認',exact:true}).click();await target.getByRole('button',{name:'提出する',exact:true}).click();
    }
   }
   await host.locator('.results-page').waitFor();await guest.locator('.results-page').waitFor();await host.getByText('あなたの問題別結果',{exact:true}).waitFor();await guest.getByText('あなたの問題別結果',{exact:true}).waitFor();
   const layouts=[];for(const width of [320,390,768,1280]){await host.setViewportSize({width,height:844});const overflow=await host.evaluate(()=>document.documentElement.scrollWidth>innerWidth);layouts.push({width,overflow});if(overflow)throw Error('Mate overflow');}
   if(errors.length)throw Error(JSON.stringify(errors));reports.push({grading,ownerPlays:true,results:true,reloadWaiting:true,errors,layouts});
  }finally{await hc.close();await gc.close();}
 }
 return reports;
}
