# 参加・開始・準備完了のDB集約：実装と公開検証

2026-10-07。対象はGitHub版 IonicFormulaCompetition。承認済み仕様は [実装仕様](superpowers/specs/2026-10-06-supabase-native-performance-sol.md)。参加・開始・準備完了は実装・公開済み。42人一斉提出には既存経路の応答待ちが残るため、アプリ全体のタイムアウト解消とは評価しない。

## 変更

- 信頼済みOriginのOPTIONSを600秒キャッシュし、Varyを保持。開始と開始状況照会のquota処理を優先する。共有quota上限は維持。
- v2参加・準備完了をprivate PostgreSQL関数へ集約。既存room transaction、ロック、認証、receipt、outboxを維持。v1は旧経路を使用する。
- native/legacy経路、アプリDB呼出数、トランザクション制御呼出数を区別して計測。通常の匿名join/readyはアプリ呼出2回（quota＋command）と制御呼出9回。内部SQLが2文になったという意味ではない。
- JWT・参加token・名前・email・解答は計測ログに追加しない。認証キャッシュ、接続増枠、grading/countdown変更は行っていない。

## 同条件の実PostgreSQL17比較

各段階20人・42人を各30回。3接続、Auth固定遅延200ms、各アプリDB呼出の追加遅延10ms、制御呼出の追加遅延0ms、flushなし。15問・3分・ion/normal/formula/immediate。start時はhost＋各参加者のstate取得を同時投入。端末保存はAPI試験の模擬処理であり、公開ブラウザーのIndexedDB保存とは別。

| 指標 p95（ms） | 旧版20人 | 第1段階20人 | 集約20人 | 旧版42人 | 第1段階42人 | 集約42人 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 全員join | 5076 | 4778 | 555 | 9777 | 9781 | 815 |
| 個々のjoin | 4695 | 4551 | 479 | 9251 | 9244 | 752 |
| 初回start | 856 | 562 | 555 | 1133 | 575 | 559 |
| manifest→全員ready | 3816 | 3645 | 1479 | 7293 | 7161 | 2628 |
| start-status | 320 | 311 | 324 | 323 | 321 | 322 |
| 同一start receipt再送 | 392 | 404 | 400 | 405 | 399 | 409 |

全員joinのp50/p95/maxは集約20人470/555/1030ms、42人770/815/815ms。個々のjoinは355/479/1022ms、503/752/814ms。その他の各試料・最大値は [raw JSON](performance/native-2026-10-07/native.json) と [baseline](performance/native-2026-10-07/baseline.json)、[第1段階](performance/native-2026-10-07/stage1.json) に保存。

全60回で10秒以上のjoin応答0、二重参加・二重COUNTDOWN0。性能目標をすべて達成し、同時採取baselineに対するstart/status p95の10%超悪化なし。runnerの`aborts`は完了応答が10秒以上だった件数で、実際にAbortSignalを発火させた件数ではない。実ブラウザーの10秒打切りは別途下記で検証した。

旧版baselineは中断前の20人26試料を保持して不足分のみ再開した。各段階開始時に専用ローカルDBを初期化し、ユーザーデータや本番DBをリセットしていない。

## 制御通信・内部SQL・混在

BEGIN/SET/lock/COMMITにも各10msを加えた感度試験を各人数2回実施。旧経路の全員join最大は20人5786ms／42人12249ms、集約版1680ms／3176ms。ready最大は5537/11307msから2810/5473ms。旧経路で個別joinの10秒以上15件、集約0件。主試験のp95と同じ精度の推定ではない。[感度旧経路](performance/native-2026-10-07/control-stage1.json)、[感度集約](performance/native-2026-10-07/control-native.json)。

auto_explainの実PG診断では通常joinと最後のreadyがそれぞれ23個のquery plan、そのうち関数内部21個。式評価等を含む全SQL文数の断定ではない。[内部SQL](performance/native-2026-10-07/internal-sql.json)。制御呼出はquota/snapshot4、room5、rollbackでも5を別計測。[制御数](performance/native-2026-10-07/control-counts.json)。

遅延なし・flush有効・2runtime・各3poolで20人室と42人室を同時運用。5/15問×immediate/deferredとnative/legacy混在8室が成功。start最大55ms、ready最大125/110ms。HTTP通知30ms、失敗1回の再送とworker終了相当のmaintenance回収も成功。[混在試験](performance/native-2026-10-07/matrix.json)。

cancel/ready、join/startの両順序、native/legacy最後のready、古いACKと新outboxの競合を実PGで確認。1.5秒ロック保持後もready勝者のcountdownはロック解放から5003ms先。同時43人は42人成功・1人拒否、参加順重複0、同一ID並行再送は同じparticipant。[競合試験](performance/native-2026-10-07/concurrency.json)。

## 公開環境（人工遅延なし）

GitHub Pages旧配信asset＋Supabase実Auth/TLS/Supavisor/Realtimeを使用。教員はユーザーがGoogleログインしたCodex内ブラウザー、参加者はPlaywrightの独立context。42人の異なる匿名UIDをDB集計で確認。学校の42台実機や学校Wi-Fiの測定ではない。

| 確認 | 公開20人 | 公開42人 |
| --- | ---: | ---: |
| 全員の参加クリック→待機画面完了 | 1764ms | 4954ms |
| manifest要求開始→最後のready応答 | 2641ms | 6760ms |
| 第1問表示 | 20/20 | 42/42 |
| 参加・開始・準備の通信失敗 | 0 | 0 |
| 教員名簿・開始操作 | 成功 | 成功 |
| manifest世代 | 1 | 1 |

通常の5秒countdownはmanifest→readyの値に含まない。DBのprepared_at→start_atは8254/12132msで、5秒を除く準備期間は3254/7132ms。42人の最後の第1問表示は予定開始時刻から1282ms後。教員IABのstart POSTそのもののHTTP応答時間は計測していないため数値を推測しない。

390×844で横overflow0。42人開始までconsole/network失敗0。20人は教員中断→全員結果表示を確認。[20人](performance/native-2026-10-07/public20.json)、[42人参加](performance/native-2026-10-07/public42-join.json)、[42人開始](performance/native-2026-10-07/public42.json)、[DB集計](performance/native-2026-10-07/public-db-state.json)。

### 追加試験で見つかった残課題：42人の一斉提出

成功した42人開始の後、未解答のまま全員を一斉に明示提出。既存operations経路で10秒打切りと再送待ちが多発し、stateにも503が発生。参加・開始の成功記録とは区別する。試験クライアントの再送を止めた時点でUIの送信確認は10人、学生の結果表示0人だった。DBは42人全員finished、ack_seq全員1、room/manifest FINISHED。再送停止後、教員の結果再取得で最終結果表示が成功した。保存・集計は成功したが、応答・結果表示の安定性は未達。

native旗の対象はjoin/readyのみで、operations/results処理は今回変更していない。旧提出経路も同じroomロックを使い、receipt再送にもGatewayのfingerprint等が実行される。この直列処理と再送による待ち増幅が原因候補。サーバーログによる内訳確認は未実施なので、正確な支配要因は断定しない。[提出試験の全記録](performance/native-2026-10-07/public42-submit.json)、[提出DB集計](performance/native-2026-10-07/public-submit-db-state.json)、[追加改修案](superpowers/specs/2026-10-07-submission-response-followup-sol.md)。

## 機能・回復・権限

最終統合後RUN_LOAD=1：101 files／545 tests成功。typecheck、Vite build、Edge bundle、diff check成功。Viteの既存500KB警告は残る。native関数の回帰は14件で、class/mate上限、public configからcountdown/両保持期限、Unicode/NFKC衝突、receipt変更・期限、REMOVED、uid再bind/epoch/audit、Google参加者、v1 fallback、cancel/旧世代/30秒期限、SQLSTATE再試行、各書込地点のrollbackとquota独立commitを含む。

ローカルPlaywrightでQRの指すURL→参加→取消→再開始→第1問→提出→双方の最終結果、390×844を確認。取消のroute解除時に試験ハーネスのalready-handled-routeエラーが出たが、APIと両画面の再開始は確認。ローカルRealtimeの404は模擬server未実装であり、本番の失敗として数えない。

同じ実URLへのGETを7秒間隔で2回送信し、CDPはGET/OPTIONS/GET（OPTIONS1回）。全体のserver OPTIONS件数には別pollが含まれるため、キャッシュ証明には使わない。

commit後応答を保留した実ブラウザー：joinは10020ms、startは10030msでTimeoutError。同じjoin ID明示再送は同じparticipantで名簿1人/revision1。同じstart IDのstart-statusと明示再送はgeneration1/revision2、同じmanifest。自動POST再実行は追加していない。

本番private schemaはData APIから406 PGRST106（公開はpublic/graphql_public）。anon/authenticatedのschema USAGEとfunction EXECUTE、PUBLIC EXECUTEはすべてfalse、関数owner postgres、SECURITY INVOKER。[権限](performance/native-2026-10-07/production-permissions.json)。

## 公開・rollback・判断記録

Supabase `slktkbpvvsfpflnmpuvr`、competition Edge27 ACTIVE。追加migration `202610060001_native_room_commands`をdry-run後適用。第1段階22→flags off計測版23→joinのみON→公開20人参加→readyもON→公開20/42人開始。現在JOIN/READYともtrue。API互換のため旧Pagesで検証可能。DB/Edge地域、Auth検証、Supavisor/接続設定は維持。

rollbackは該当`COMPETITION_NATIVE_JOIN`／`COMPETITION_NATIVE_READY`をfalseにしてEdgeを再公開。追加関数・receipt・既存データは保持する。エラー時の自動legacy再実行やDB削除は行わない。

fresh全体レビューでCritical/Importantなし。指摘の空白修正とpublic config整合テストを追加。レビュー単独では実PG性能や公開権限を実行していないため、それらは本レポートの追加実行証拠で補完した。

既存branchを保持して作業。公開・pushはユーザー承認済みのため追加承認待ちにしない。origin/mainに後から追加されたCloudflareビルド設定4commitを保持して統合した。追加提出問題に合わせて仕様が除外したgradingや全提出経路まで変更せず、今回の公開範囲と残課題を区別する。

公開code commitは `39b6ead922bb431021e5eecf2ee468d0ba5b3bec`。[GitHub Actions](https://github.com/KoiChem/IonicFormulaCompetition/actions/runs/37620553926) のbuild/deployともsuccess、CIでも545 tests成功。GitHub MCPでjob steps/logを確認。push起動run一覧はMCPがPR起動分に限定されるためCLIでrun IDを取得した。公開Playwright再読込で `index-BFCAjfiW.js`／`index-B0HBjL6V.css` を確認し、pageerror/requestfailed/HTTP400以上は0。[公開画面](performance/native-2026-10-07/published-home.png)。

実機カメラでのQR読取、学校Wi-Fi、iOS/Safari、長時間本番負荷、Cloudflareの実デプロイは未確認。
