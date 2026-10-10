async (page) => {
  const origin = new URL(page.url()).origin;
  const errors=[];const failed=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('requestfailed',r=>failed.push(r.url()));
  await page.goto(origin);
  const mate=page.getByRole('button',{name:'メイトマッチ',exact:true});
  if(!await mate.isDisabled())throw new Error('Mate must be disabled');
  await page.getByRole('link',{name:'クラスコンペ',exact:true}).click();
  await page.getByRole('button',{name:'5問',exact:true}).click();
  await page.getByRole('button',{name:'イオン名',exact:true}).click();
  await page.getByRole('button',{name:'クラスルームを作る',exact:true}).click();
  await page.locator('.code strong').waitFor();
  const code=await page.locator('.code strong').innerText();
  const studentContext=await page.context().browser().newContext({viewport:{width:390,height:844}});
  const student=await studentContext.newPage();let reviewRequests=0;student.on('websocket',ws=>ws.on('framesent',frame=>{try{if(JSON.parse(frame.payload).type==='review')reviewRequests++;}catch{}}));
  student.on('pageerror',e=>errors.push(e.message));student.on('requestfailed',r=>failed.push(r.url()));
  await student.goto(`${origin}/#/join/${code}`);
  await student.getByLabel('ニックネーム').fill('ブラウザ確認生徒');
  await student.getByRole('button',{name:'参加する',exact:true}).click();
  await student.getByText('開始を待っています').waitFor();
  await page.getByText('ブラウザ確認生徒',{exact:true}).waitFor();
  await page.getByRole('button',{name:'問題を準備して開始',exact:true}).click();
  await student.getByText('第1問 / 全5問',{exact:true}).waitFor();
  await student.getByRole('button',{name:'パス',exact:true}).waitFor({state:'visible'});
  await student.waitForFunction(()=>!document.querySelector('[data-testid="pass"]')?.disabled);
  await student.getByRole('textbox',{name:'イオン名',exact:true}).fill('不正解の確認');
  await student.getByRole('button',{name:'解答をチェック'}).click();
  await student.getByText('× 不正解',{exact:true}).waitFor();
  await student.getByText('第1問 / 全5問',{exact:true}).waitFor();
  await student.getByRole('button',{name:'パス',exact:true}).click();
  await student.getByText('第2問 / 全5問',{exact:true}).waitFor();
  await student.reload();
  await student.getByText('第2問 / 全5問',{exact:true}).waitFor();
  const restored=true;
  await studentContext.setOffline(true);
  await student.getByText(/通信を再確認|通信が戻る/).waitFor();
  await studentContext.setOffline(false);
  await student.waitForFunction(()=>!document.querySelector('[data-testid="pass"]')?.disabled);
  for(let i=2;i<=5;i++){
    await student.getByText(`第${i}問 / 全5問`,{exact:true}).waitFor();
    await student.getByRole('button',{name:'パス',exact:true}).click();
  }
  await student.getByRole('heading',{name:'全解答確認'}).waitFor();
  await student.waitForTimeout(500);if(reviewRequests!==1)throw new Error(`Review loop: ${reviewRequests}`);
  await student.reload();await student.getByRole('heading',{name:'全解答確認'}).waitFor();
  await student.getByRole('button',{name:'名称：パス・再解答する',exact:true}).first().click();
  await student.getByRole('textbox',{name:'イオン名',exact:true}).fill('最終確認からの誤答');
  await student.getByRole('button',{name:'解答をチェック'}).click();await student.getByText('× 不正解',{exact:true}).waitFor();
  await student.locator('.play-answering').waitFor({timeout:2000});
  await student.getByRole('button',{name:'確認一覧へ戻る',exact:true}).click();
  await student.getByRole('button',{name:'このまま提出',exact:true}).click();
  await student.getByRole('button',{name:'提出を確定する',exact:true}).click();
  await student.getByRole('heading',{name:'あなたの結果'}).waitFor();
  await page.getByRole('heading',{name:'最終結果'}).waitFor();
  if(await student.getByRole('heading',{name:'クラス集計'}).count())throw new Error('Student sees teacher aggregate');await student.getByRole('heading',{name:'上位3位',exact:true}).waitFor();
  const layouts=[];
  for(const width of [320,390,768,1280]){
    await student.setViewportSize({width,height:844});
    const overflow=await student.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
    layouts.push({width,overflow});if(overflow)throw new Error(`Overflow at ${width}`);
  }
  const originalId=await student.evaluate(code=>{
    const key=`ionic-lite:participant:${code}`;const c=JSON.parse(localStorage.getItem(key));
    c.expiresAtMs=Date.now()-60*60*1000;localStorage.setItem(key,JSON.stringify(c));return c.participantId;
  },code);
  await student.reload();await student.getByRole('heading',{name:'あなたの結果'}).waitFor();
  const retainedIdentity=await student.evaluate(code=>JSON.parse(localStorage.getItem(`ionic-lite:participant:${code}`)).participantId,code);
  if(originalId!==retainedIdentity)throw new Error('Offline-at-start identity was replaced');
  await page.reload();await page.getByRole('heading',{name:'最終結果'}).waitFor();
  const result={code,restored,teacherReload:true,offlineAtStartRecovery:true,layouts,errors,failed,studentTopThreeAndOwnReview:true};
  await studentContext.close();
  if(errors.length||failed.filter(url=>!url.includes('/socket')).length)throw new Error(JSON.stringify(result));
  return result;
}
