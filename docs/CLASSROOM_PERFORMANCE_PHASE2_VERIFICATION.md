# クラス同時参加・開始の性能改善 第2段階

2026-10-05。承認仕様: `superpowers/specs/2026-10-05-classroom-performance-phase2-design.md`。

## 変更と安全性

通常のstate/manifest/realtimeをread-only snapshotへ分離した。command、通常read、優先status/quotaは最大1接続ずつ、計3接続/isolate。開始確認は通常quotaの42件burstの後ろに並ばない。期限境界・全員提出・正当な資格再関連付けは従来のroom transactionへ戻り、同じtransactionで認可・遷移・応答を再確認する。REMOVED/不正token/他人のparticipant IDを許可しない。

ready時の全名簿比較と不要なroom再取得を削減。Authの一時障害は503+Retry-Afterとなり、401による資格更新とは区別する。同一タブの同時401は一度のrefreshを共有し、POSTは自動再送しない。Authのremote verificationは維持した。

通知の保留/予算skip/lease/送信失敗は次回時刻を返し、上限付き再試行を行う。外部HTTP中にtransaction/接続を保持しない。専用secret、Vault、pg_cron/pg_netによる毎分の保護された保守処理がworker終了後のoutboxを回収し、既存保持期限で清掃する。8室/回の回収は最終試行の古い順に回し、失敗室による飢餓を防ぐ。定期回復は毎分であり、障害時の数秒以内配信を保証するものではない。

通知・poll・visibility・明示的refreshを一つのschedulerへ統合。取得中の変更は後続取得へ残し、Retry-Afterを通知で短縮しない。room/tokenが同じ間はphase変更でschedulerを破棄せず、取消後のrefreshが誤った失敗表示にならない。時計の境界同期を維持した。

## 自動試験とレビュー

- RUN_LOAD=1 Vitest: **100ファイル・529件成功**。型検査、production build、Edge bundle、diff check成功。既存の500kB chunk警告は残る。
- Auth障害/refresh共有、snapshotのwrite/flushゼロ、uid再関連付け、削除者、participant ID不一致、deadline finalize、通知lease/予算skip/再送、保守lease/fair rotation、scheduler dirty/stop/backoffを検証。
- 独立レビューのImportant 2件を修正。42件quota burstでstatusが44番目になるREDを再現し、3番目以内になるGREENを確認。PREPARINGのpollを保持して取消すると「Room synchronization stopped」が表示されるPlaywright REDを再現し、修正後はdialogゼロで再開始できた。
- ローカルPlaywright: QRが指す参加URL、開始、取消、再開始、第1問、提出、両者の最終結果、390×844の横はみ出しなし。Authはfixture、テストAPIはPGlite、Realtime WebSocketは未実装のため404となる。これは実Googleログイン/実Realtimeの代替ではない。

## 実PostgreSQLの性能測定

PostgreSQL17、postgres.js、localhost、ssl=false。固定Auth fixtureに200ms、SQLごと10msの追加遅延。15問/immediate、20人・42人それぞれ30回。join確定後にhost+参加者stateを一斉に投入して、その後start。負荷測定は通知flushを除外。各回のreceipt、同一start再送のgeneration1、manifest→ready→COUNTDOWNを確認。学校回線、Edge/Supavisor/TLS、物理端末の実測ではない。

| 人数 | 前回start p95 | 今回start p95 / max | 前回manifest→全員ready p95 | 今回ready p95 / max |
| --- | --- | --- | --- | --- |
| 20 | 4.161秒 | **0.842 / 0.843秒** | 7.308秒 | **3.718 / 3.735秒** |
| 42 | 7.824秒 | **1.149 / 1.153秒** | 15.240秒 | **7.377 / 7.411秒** |

前回は計2接続、今回は計3接続。今回の全60回で開始時間切れ/二重generationゼロ。仕様のstart 2/3秒、ready 5/8秒目標を満たした。ready区間は開始POSTやreceipt確認、再送確認を含まず、カウントダウンや端末保存/描画も含まない。

増枠だけの効果と区別する対照試験は、今回のnormal readとcriticalを共有して旧構成と同じ計2接続、同じAuth/SQL遅延、各2回。start最大20人1.807秒/42人2.977秒、ready最大4.808秒/9.743秒。2接続でも開始は改善するが、42人readyは8秒目標未達。各2回なので30回p95と同等の統計ではない。本番は検証済み3接続を採用。

## 通知・競合・接続寿命

- 2 runtime×3接続、同時2室(20人/42人)、5/15問×immediate/deferred全8組。Auth/SQL追加遅延ゼロ、通知HTTP30ms、flush有効。開始最大74ms、ready最大20人140ms/42人128ms。通知96送信、一時失敗1回を注入して再送。foreground workerが回収しない新規室を作り、追加参加APIなしで保守処理による回収を確認。これは通知を含む整合性確認で、上の遅延付き30回と速度を直接比較しない。
- 未コミットroom更新とadvisory lock中のstart-statusは20msで旧revisionを返す。外部送信3秒保持中のopen transactionは0、別処理+statusは4ms。制約違反で全体rollback。
- idle_timeout 1/10/20秒、1.6秒間隔×3回のローカルA/B。1秒はPID3個・8〜17ms、10/20秒はPID1個・warm2〜3ms。改善は数msで、本番TLS/poolerでは未測定。占有を増やす変更を見送り、本番1秒を維持。

## 本番反映

- 後方互換の追加migration `202610050001`。dry-runで以前から未反映だった `202610040001_shared_teacher_authority.sql` も検出し、既存テーブルが未作成であることを照合して両方適用。既存room/participant/receipt/outboxをリセットしない。
- Supabase competition **version21 ACTIVE**、verify_jwt=false。専用保守secretはEdge/Vaultのみ。Cron毎分の実呼出HTTP200、last_success更新を確認。保守認証はブラウザーに公開しない。
- 旧Pages `index-CmJ0yOts.js` と新Edgeの実Auth/実Realtime/APIで2人mate参加→開始→第1問→提出→両者最終結果、390×844横はみ出しなしを確認。
- 実装commit `dd25bc841d9788b7ae8efb6889dae02cf937efb6` をpush。Pages [Actions 37307524370](https://github.com/KoiChem/IonicFormulaCompetition/actions/runs/37307524370) のbuild/deploy両方成功。
- 公開JS `index-BFCAjfiW.js` SHA256 `c9fa6628cfc10d18d1447f27377627490af444397f15397a8984c3331a7e3b13`、CSS `index-B0HBjL6V.css` SHA256 `453e6d60762974423998f9993eafae32b82b02bec2a7c159676cee3bdb8f7de1`。HTTP200でローカルbuildと一致。
- 新UI/実Auth/実Realtime/APIの2人mateで参加→開始→第1問→提出→両者最終結果を確認。開始POST応答874ms、開始クリックから第1問表示はhost8.862秒/参加者9.368秒。既定5秒カウントダウンを単純に引くと3.862秒/4.368秒（端末保存・時計・描画・ネットワークを含む単発確認で、classroom30回p95ではない）。POST1回/status1回、画面例外/console error/通信失敗/HTTPエラーゼロ。390×844で参加・解答・結果の横はみ出しなし。
- 両者のFINISHED stateが200でrequest-idを持つこと、専用キーなしのmaintenanceが403になることを確認。Cron直近3回がHTTP200/timeoutなし、本番outbox pending0を観測。

本番DBのmax_connections60、保守と少人数確認中client backend11を観測。3接続/isolateの全てが常時使われるわけではなく、1秒idleで解放する。isolate数/プロジェクト共有poolerの最大負荷と、本番20/42台の学校回線は未測定。大人数試験は使い捨てDBのみに実施した。

Rollback: server secret `COMPETITION_SNAPSHOT_READS=false` で旧経路へ戻せる。UI/Edgeは直前版へ戻せるが追加列/保守テーブルは残し、実行中データを削除しない。前回公開 `15dd01b`/Edge version19を参考に、その後の共有教員変更を保持する。
