# Sol向け追加仕様案：一斉提出の応答と結果取得

状態：調査からの追加案。今回公開したjoin/ready集約には含まれず、以下は未実装。先に本番ログと旧経路の同条件再現で原因を確定する。

## 実測した問題

2026-10-07の公開42人クラス。参加・準備・開始は全員成功。その後42人が未解答のまま同時に明示提出し、operations応答の打切りと再送待ち、state503が多発。再送停止時UI送信確認10/42、DBはfinished42/42、ack_seq1、room/manifest FINISHED。教員は結果再取得で回復。実録は `docs/performance/native-2026-10-07/public42-submit.json`。

既存Gatewayはoperationsにもroomロックと前後fingerprintを使う。batch receipt再送でもその周辺処理が走る。PostgresDatabase.batchは各statementを逐次実行。これらの往復・ロック保持とクライアント再送の増幅を原因候補として調べる。未確認のCPU・pool・Realtime要因は断定しない。

## 不変条件

- 10秒のAPI打切り、現在のpool/地域/認証・quotaを維持。単に待機時間や接続数を増やして合格にしない。
- TypeScriptの既存replayV2Operationsと化学採点を保持。seq、writer_epoch、body_hash、requestId、receipt、cutoff/collection期限、token、REMOVED、UID再bindの契約を変えない。
- 未確認提出を成功表示しない。端末内解答と同一batch/requestIdの明示再送を保持。タイムアウト時に別IDを作らない。
- 結果確定後の明細と順位はimmutableとして扱い、読み取り高速化で権限や採点を省略しない。

## 実装順序

1. **診断を先行**：20/42人の同時finish、通常の分散解答→finish、5/15問×immediate/deferredを実PGで再現。Auth・quota・pool待ち・room lock・DB work・application/control call・retryを分離。公開の最初のfinishと同一receipt再送を別集計する。固定mockを本番速度とみなさない。
2. **receipt再送の短縮**：認証・参加資格確認後、既存receiptが同じbodyなら書込/fingerprint/outbox更新を省く経路を設ける。REMOVED、別token、別body、writer変更、epoch変更に関する既存挙動を契約比較する。条件を満たさない場合は新規書込前に旧経路へ戻せる。実行エラー後のPOSTの旧経路再実行は禁止。
3. **確定結果のread-only取得**：確定済みかつ権限を満たすresults/result-summaryをsnapshot/read poolから読む。room fingerprintやroom書込ロックを省き、全結果または自分の明細を必要な少数queryで取得する。未確定室は既存transition経路を保持。結果公開範囲は既存HTTPと完全に一致させる。
4. **DB呼出削減**：operationsの新規処理でも複数operation INSERTをbulk化し、finalizeの参加者ごとのoperation読取を室単位で取得して既存TS採点へ渡す。既存バッチ原子性、command marker、CAS失敗後receipt回復を保つ。SQLite/PGliteとPGの互換を維持し、PG用変更を必要以上に共有経路へ押し込まない。
5. **必要ならprivate command化**：上記でも目標を満たさない場合、検証済みの入力・receipt・bulk persistをprivate関数へ集約。TS採点をSQLへ移植しない。TS評価を挟むsnapshot→commitではCASと新しいDB時計による期限再検証を必須にし、競合時は再評価する。採点用snapshot/世代が変わったまま書き込まない。
6. **再送負荷の制御**：同一端末の同一batchでin-flightを共有し、receipt不明中の重複POSTを抑える。既存backoffを検証し、deadline後に無限POSTを繰り返さず、保存済みかの確認と結果再取得へ移れることをテスト。署名済みレスポンスやreceiptなしに成功を推測しない。

各項目はそれぞれのRED→GREEN回帰テストとAPI契約比較を先に行う。診断結果に応じて2〜4で十分なら5を追加しない。新しいflagは既定OFFで独立rollback可能にする。

## 必須検証・公開ゲート

- 20/42人、各30回、同じ人工遅延モデルと別の遅延なし/flush有効/複数workerで比較。初回operationsとreceipt replay、全員の確認済みACK、全員の結果表示を別に記録。
- 各人数で10秒AbortSignal0、保存済み全員のACK表示、学生全員と教員の結果取得、二重operation/receipt/順位確定0。初回・再送それぞれp50/p95/maxと全員完了時間を残す。公開42人が全員保存済みでもUI確認が揃わない場合は不合格。
- finish対deadline/interrupt/remove、同一requestId並行再送、異なるbody、writer epoch変更、旧manifest、cutoff直前/直後、応答切断後回復、worker終了と通知回収、書込障害rollback。
- 公開の異なるAuth UID42人、390×844、実IndexedDB、Auth/TLS/Supavisor/Realtime、console/network失敗を確認。通常5秒countdownを提出時間へ混ぜない。
- 既存native join/readyの性能・権限・旧Pages互換を維持。追加migrationのprivate権限とsearch_pathを検証。既存データは削除しない。

公開はreceipt/read短縮から段階的に行い、問題時はそのflagのみOFF。今回のJOIN/READY flagsはそのまま独立して管理する。
