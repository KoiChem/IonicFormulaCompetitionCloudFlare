# IonicFormulaCompetition Lite

Goal: 授業用クラスコンペを、1 Room = 1 SQLite-backed Durable Object、WebSocket中心で最大50人に提供する。
Spec: このチャットで承認されたLite仕様と3点の設計案。現行Worker・DB・実施データは変更・移行しない。

## Constraints
- Worker名 ionicformulacompetition-lite。現行の公開スクリプトは使わない。
- 正解数降順、所要時間昇順、両方同じなら同順位。既存の回答欄ごとの得点を継承。
- 即時採点、誤答ペナルティなし、再回答可、ヒントなし、パスあり。
- 生徒は本人の結果のみ。教員は管理tokenで全体結果・進行を扱う。
- 既存教材・出題・入力部品・CSSを参照。Auth、D1、outbox、polling、Mate本体を含めない。
- 通常操作はWebSocket 1往復。保存後に応答し、再接続時に本人向け状態を返す。

## Tasks
1. [x] Native Worker tests first: 50人・51人目拒否、二重送信、本人限定結果、再接続、締切、SQLite復帰。worker/index.ts・room.ts・protocol.tsを実装。
2. [x] Browser flow first: 教員作成→QR/コード参加→開始→回答/パス→終了→結果。既存入力・表示部品を使いApp・Player・Results・socketを実装。
3. [x] Lite全テスト・型検査・build・Worker dry-run。既存テストの回帰確認、Playwrightで狭幅・送信状態・再読み込み・通信エラーを確認。
4. [ ] 対象ファイルのみcommit/push。専用設定から公開、build identity・公開画面・WSS・25/50人の参加/回答時間を確認。

## Review focus
- 同時参加と再接続を人数に二重計上しない。
- 応答喪失後の再送と複数タブで二重得点/次問誤操作が起きない。
- 再起動・切断中の終了、締切後の回答で得点が変わらない。
- 未認証/生徒に他人の結果・正解・管理tokenを返さない。
- IME確定中のEnter、タッチ入力、長い問題文、320px幅。

## Progress / decisions
- Current baseline: 571 tests passed, 3 load tests skipped (load flag not set).
- Reuse the existing 7-day class result retention and 2-hour waiting-room lifetime. Show the result deadline; no global history or settings DB.
- Use the existing 5-second synchronized countdown (excluded separately from latency reports). Prepare questions on Room creation to avoid preparation handshakes.
- Work in a dedicated branch in the existing checkout; all new files stay under lite/.

- Independent review found one recovery defect: credentials with a provisional waiting expiry were hidden after offline start. Browser identity now survives the maximum possible Room extension; the server remains authoritative for expiry. Regression covers local retention and browser restoration to results.
- Existing verification: 574 general tests, 28 native Cloudflare tests, 18 Worker WebSocket tests, typechecks/build passed. Lite verification: 20 tests, typechecks/build and dry-run.
- Local 50-client answer acknowledgment: median 34.0 ms, p95 47.5 ms, max 60.4 ms. See local-load.json. These are local-runtime measurements, not classroom/public latency.
