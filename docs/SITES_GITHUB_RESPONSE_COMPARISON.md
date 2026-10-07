# Sites版とGitHub版の応答比較

2026-10-05。依頼: GitHub版の既存結果を使い、ChatGPT Sites版を同様の条件で測定する。アプリ改修・公開は行っていない。

## 比較対象

- GitHub版: `dd25bc8` の性能改善。既存実PostgreSQL試験は `CLASSROOM_PERFORMANCE_PHASE2_VERIFICATION.md`。
- Sites版: https://ion-compe.koichem.chatgpt.site 、Sites APIで現行version33を確認。公開versionのsource commit `8e5378e76f4d0f3db8a8b44dc0ef8237ceaebc4d` がローカルcheckoutと一致し、差分なし。
- GitHub版の速度はGitHub Pagesの静的配信とSupabase APIの組合せ、Sites版のAPIはCloudflare Workers+D1。ホスティング名だけの比較ではない。

## 共通負荷モデル: 各30回

15問、ion/normal/formula、immediate、3分。20人/42人を並行参加。参加完了後、host+各参加者stateを並行投入し、startを追加。同一requestIdの再送がgeneration1のまま、manifest取得から全員ready、COUNTDOWN確定、1manifestを各回確認した。

GitHub版のAuth200ms、SQLごと10msという追加遅延に対応して、Sites版には各要求の共通前処理200msとSQLごとの往復10msを追加した。Sites版の参加者には実際にはSupabase Auth照会がないため、200msは比較用の共通遅延であり、実認証処理を測った値ではない。D1 batchにはSQL本数×10msをbatch実行前に加え、batch自体のatomicityを維持した。実D1はbatch内の複数SQLを1回の呼出にまとめるため、この追加遅延は保守的なモデルとなる。

Sites版はNode SQLiteの既存D1互換テストアダプターで測定。SQLiteの実SQL実行は単一DBで逐次、追加の往復遅延は呼出ごとに重なる。Cloudflare D1の実行待ち・CPU・region・通信・Worker isolateを完全に再現してはいない。GitHub版は実PostgreSQL17/local/ssl=false、command/read/critical各1接続、通知flushなし。Sites版にSupabaseの接続プールやquota gatewayを人工的に追加していない。

**以下は公開サービスの実測同士ではなく、共通負荷モデルの比較。**

| 人数/測定区間 | GitHub p95 / max | Sites互換モデル p95 / max |
| --- | --- | --- |
| 20人 start POST | 0.842 / 0.843秒 | 0.459 / 0.460秒 |
| 42人 start POST | 1.149 / 1.153秒 | 0.462 / 0.463秒 |
| 20人 manifest→全員ready | 3.718 / 3.735秒 | 0.580 / 0.581秒 |
| 42人 manifest→全員ready | 7.377 / 7.411秒 | 0.597 / 0.613秒 |

全60回でエラー・二重manifestゼロ。ready区間はstartの待ち、時計、IndexedDB、カウントダウン、端末の第1問描画を含まない。

このモデルではSites版の開始処理が約45%/60%短い。準備完了は約84%/92%短い。ただし実サービスで同じ倍率が出ることは示していない。D1 batchやCASによる処理と、Supabaseのtransaction/command poolによる直列処理の差が含まれる。

## 公開サービスの補助実測: 2人、各1回

両者ともブラウザー(Playwright)のmate、5問、5分、immediate、ion/normal、式または名。追加遅延なし。GitHub版は先ほどの公開確認値を再利用し、Sites版を今回測定。

| 区間 | GitHub公開版 | Sites公開版 |
| --- | --- | --- |
| 開始クリック→start応答 | 0.874秒 | 1.146秒 |
| 開始クリック→第1問表示 host | 8.862秒 | 13.383秒 |
| 同 participant | 9.368秒 | 13.885秒 |

第1問表示はどちらも既定5秒カウントダウンを含む。単純に引くと全員表示まで4.368秒/8.885秒。時計同期、poll、IndexedDB、API、描画を含む総体。単発値でありp95ではなく、異なる時刻の測定なので普遍的な優劣は判断しない。少なくとも「ローカルのAPIモデルが速い＝公開画面も速い」とは結論できない。

Sites版もPOST1回、両者第1問→提出→最終結果、390×844横はみ出しなし、当該ページのpageerror/requestfailedゼロ。別の終了済みlocalhostタブの接続失敗はSites測定に含めない。

別途Node fetch HTTPSで15問/2人の単発確認も実施。start1.344秒、manifest→ready1.769秒、両者提出後FINISHED。こちらは上のブラウザー5問試験とは別条件。

## 公開クラス試験

ユーザーの通常Chromeで管理者教員ログインを確認し、同じブラウザーのfetchで実教員cookieを使った。Playwright MCPは通常Chromeの認証セッションに接続できないため、native CUAからDevToolsコンソールで測定した。参加者はそれぞれ独立したtokenを使い、credentials:omit。認証cookieは抽出せず、代用ヘッダーも偽造していない。20/42台の実端末ではなく、1ブラウザーから独立tokenの並列API要求を送る試験である。

初回は測定コードでアプリのstate取得にあるcache:no-storeが欠け、同一URLの並列state要求が10秒でtimeoutした（start応答は0.984秒）。cache:no-storeを合わせた再試験では成功。Chromeの同一URL cache lockの影響と整合するが、単一変数の前後比較だけで全原因は断定しない。初回失敗は隠さず、修正後の30回統計には混ぜない。未開始の試験室はcancel-preparationでWAITINGへ戻した。PREPARING室へのinterruptはinvalid_state409であり、cleanup手順を修正した。

公開試験には人工的なAuth/SQL遅延を追加できないため、人数・設定・投入順は揃えるが、遅延付きGitHub試験と同一環境ではない。manifest→readyはAPI並列処理のみであり、IndexedDB、時計同期、継続poll、第1問描画、カウントダウンを含まない。

20人30回成功。開始p50 1.021秒、p95 1.649秒、max2.071秒。準備p50 2.115秒、p95 4.580秒、max5.089秒。42人30回も成功。開始p50 1.238秒、p95 3.231秒、max3.371秒。準備p50 2.532秒、p95 5.288秒、max5.326秒。修正後の全60回で10秒timeout、APIエラー、二重準備世代ゼロ。全試験室はinterrupt応答成功まで確認。p95は昇順ceil(n×0.95)番目、p50はceil(n×0.5)番目。

## 証拠と再現用ファイル

- ローカル測定: `.cache/sites-comparison/benchmark.ts` と生成した `benchmark.mjs`。
- 全60回のraw samples: `/private/tmp/ionic-sites-comparison-result.json`。
- 公開Node 2人: `/private/tmp/ionic-sites-live-mate-result.json`。
- 公開クラス全60回: `/private/tmp/ionic-sites-live-class-result.json`（通常Chromeで取得）。
- 公開クラス計測の準備: `.cache/sites-comparison/live-class-playwright.js`。

D1のbatchとsingle-threaded実行の契約は [D1Database公式文書](https://developers.cloudflare.com/d1/worker-api/d1-database/) と [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) を確認した。1呼出のbatchと1SQLごとの往復を混同しない。

## 結論

共通の人工遅延モデルではSites版のAPI処理が短い。一方、公開2人の単発画面試験はGitHub版の方が開始応答・第1問表示とも短かった。公開Sitesのクラス開始は中央値約1.0〜1.2秒、p95約1.6〜3.2秒で、測定設定をアプリに揃えた全60回が成功した。現時点の証拠からGitHub版が一律に遅いとはいえない。

GitHubの既存遅延モデルp95と公開Sitesのp95を混ぜた順位づけは行わない。継続的な速度改善を評価するなら、次の比較は両公開版を同じ時刻・回線・独立ブラウザー群で、開始クリック→第1問表示まで揃えて測る必要がある。今回の実測はQRカメラ起動、端末別IndexedDB、学校Wi-Fiや42台の描画負荷を検証していない。
