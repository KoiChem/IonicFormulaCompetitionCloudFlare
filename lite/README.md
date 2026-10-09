# IonicFormulaCompetition Lite

授業用、最大50人のクラスコンペ。現行アプリの教材・出題・採点・入力・QR・走者表示を使い、保存と競技操作を1 Room = 1 SQLite-backed Durable Objectにまとめています。

## 使い方
- 教員：「クラスコンペ」→設定→作成→QR/参加コードを共有→「5秒後に開始」。アカウント不要。
- 生徒：QRまたはコードからnicknameで参加。正解数優先、同点は所要時間順。同条件は同順位。
- 設定画面の「難易度調整」から、通常版と同じ割合・イオン・化合物の設定を変更できます。初期値は通常版の保存済み設定（revision 3、2026-10-09取得）です。変更はこのブラウザに保存し、新しく作成するRoomの出題に反映します。
- 即時採点、誤答ペナルティなし、再回答可、ヒントなし、パスあり。「全解答確認」からパスした問題を再解答し、「このまま提出」で確定できます。全問正解なら自動で提出します。組成式と名称の両方を答える設定は各欄1点。
- 生徒は自分の結果と復習、教員は全体結果を閲覧。管理tokenはQRに含めません。
- 同じブラウザから再読み込み・ホームの「過去の結果」で復帰。管理/参加情報はブラウザに保存するので、作成したブラウザを使ってください。
- 待機Roomは2時間、開始したRoomと結果は7日間保存し、期限後はRoomのデータを削除します。期限は結果画面に表示。
- メイトマッチはdisabled表示のみ。

## 開発・検証・公開
既存リポジトリのNode/pnpmとインストール済み依存を利用します。リポジトリルートで `pnpm install --frozen-lockfile` の後：

```sh
pnpm --dir lite test
pnpm --dir lite build
pnpm --dir lite dev
pnpm --dir lite load http://localhost:8791
pnpm --dir lite deploy
```

公開は `lite/deploy.mjs` だけを使います。Worker名・LiteRoom・D1なしを検査してから、専用設定 `lite/wrangler.jsonc` に対してdeployします。現行版用のルートのdeployコマンドは使いません。公開成果物のcommitは `/api/health` とHTMLの `lite-release` metaで確認できます。

Playwright MCPで `tests/browser-flow.js` の関数を実行すると、教員作成・参加・誤答・パス・再読み込み・offline/online復帰・本人限定結果・320/390/768/1280pxを検証できます。`tests/ui-parity.js` はホーム・設定の配置、難易度保存、式入力、両欄パス・再解答・入力復元を検証します。`load.mjs` は25/50人の接続・正答・重複送信を検証し、1往復の時間を出力します。計測対象はLiteのURLに限定しています。

## 構成
WorkerはRoom作成、静的配信、WebSocketの転送のみ。LiteRoom内の `room`、`participants`、`answers` の3テーブルで進行を管理し、同期SQLiteトランザクションで登録上限・採点・操作番号を更新します。回答は本人に判定と次問を返し、教員には進捗だけをpushします。全員への通知は参加・開始・終了に限定。切断後は同じtokenで本人向け状態を復元します。

OAuth、D1、Supabase、既存実施データの移行、polling、outbox、汎用バックエンド互換、Mate本体はありません。Lite専用の新規DO名前空間を使います。

参照：[Cloudflare SQLite Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)（2026-10-09確認）。
