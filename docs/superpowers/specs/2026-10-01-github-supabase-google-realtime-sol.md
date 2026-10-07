# イオンコンペ GitHub Pages / Supabase版 — Sol実装仕様

作成日: 2026-10-01。状態: 実装引き継ぎ用の設計。アプリの実装・公開、Supabase設定は未実施。

## 1. 目的と決定事項

既存のイオンコンペを、GitHub Pagesの静的フロントエンドとSupabaseのバックエンドで動く独立したWebアプリにする。実行時にChatGPTのログイン・契約・Sites APIを必要としない構成とする。

| 項目 | 方針 |
| --- | --- |
| 既存版 | `../IonicFormulaCompetition` をSites版として保持 |
| 新版 | この `IonicFormulaCompetitionGitHub` フォルダーで開発 |
| 公開先 | GitHubリポジトリ `KoiChem/IonicFormulaCompetition` のGitHub Pages |
| 想定URL | `https://koichem.github.io/IonicFormulaCompetition/`。公開設定時に確認 |
| DB・認証・API・通知 | Supabase Postgres / Auth / Edge Functions / Realtime |
| 教員認証 | Googleログインと教員許可リストの組み合わせ |
| 生徒 | Googleログインやアカウント登録画面なしで参加 |
| 最初の運用規模 | 教員約5名、1クラス最大42名。同時利用数は未確定のため両ケースを見積もる |
| データ移行 | 初期版は新規DBで開始。Sitesの稼働中ルーム・既存成績の移行は含めない |

同じ画面・化学問題・競技規則を引き継ぐ。今回の主目的は基盤の置換と通知の改善であり、問題や競技ルールの再設計ではない。

## 2. 調査結果と実装時の基準

調査した現行実装では、問題毎判定は既に端末内で即時判定し、記録をサーバーが再計算して確認するv2方式である。「毎解答の判定が通信待ちなのでSupabase化で即時化する」という説明は採用しない。主な改善対象は、進捗・開始・中断・確定が他端末に伝わるまでの時間である。

実装開始時に既存版のコミット・未コミット差分・主要ファイルの内容を記録し、その時点の動作を移植基準とする。古いREADMEと実装が違う場合、最新のv2実装と以下の設計を照合する。設計書だけにある未実装機能を、既存機能として扱わない。

主な参照先（既存版ルートからの相対パス）:

- `docs/superpowers/specs/2026-09-25-grading-modes-and-local-play.md`
- `docs/superpowers/specs/2026-09-30-rejoin-and-race-motion-sol.md`（適用済み範囲をコードで確認）
- `src/features/play/CompetitionPlayerV2.tsx`、`useRoomSync.ts`、`v2-send-policy.ts`
- `src/persistence/v2-manifest.ts`、`src/persistence/db.ts`、`db/schema.ts`
- `src/features/lobby/host-race-model.ts`、`HostRace.tsx`、`RoomScreen.tsx`
- `src/config/public.ts`、`src/platform/sites-runtime.ts`、`app/chatgpt-auth.ts`

調査時の既定値: 5/10/15問（既定10問）、3〜10分（既定5分）、クラス42名、なかま4名、開始カウントダウン5秒、待機ルーム2時間。結果保持はクラス7日、なかま24時間、中止24時間。実装時に再確認して維持する。

### Gitと接続の確認状況

- GitHub MCPで `KoiChem` の認証と公開リポジトリ `KoiChem/IonicFormulaCompetition` の存在を確認。既定ブランチは `main`。
- 新フォルダーには独立した `.git` がなく、親 `chem` のGit管理に入っている。仕様作成時点では初期化・コミット・pushしていない。
- 実装時はリモート内容を取得・比較し、既存ファイルを保存した上でこのフォルダーと対象リポジトリを正しく関連付ける。親リポジトリやSites版の変更を巻き込まない。必要な新ブランチは `codex/` 接頭辞。
- Playwright MCP接続を確認したが、アプリ検証は未実施。Playwrightの空タブはSafariのログインセッションではない。
- Supabase専用MCPは見つかっていない。Safariのログイン状態・対象プロジェクト・使用量は未確認。実装時は利用可能な公式CLIまたは管理画面で確認する。

## 3. アーキテクチャ

```text
GitHub Pages: React + Vite SPA
  ├─ Supabase Auth: 教員Google OAuth / 生徒の匿名セッション
  ├─ HTTPS → Edge Functions → 認可・共通採点 → Postgresの原子的更新
  └─ Private Realtime Broadcast ← 確定した状態に基づくサーバー通知
```

### フロントエンド

- 現行ReactのUI・問題データ・純粋関数を再利用する。Nextのサーバールート、Cloudflare D1、Sites認証への依存を外す。
- Viteの静的ビルドを採用。`base` は `/IonicFormulaCompetition/`。URL生成を一元化する。
- Pagesの直リンク404を避けるためハッシュルーティングを採用する。例: `/#/teacher`、`/#/rooms/{id}`（実URLには上記baseが付く）。QR・共有URL・戻る・再読込もこの形式に統一。
- Google OAuthはPKCE。戻り先をPagesのbase URLにし、クエリの認証コードを交換してから保存済みのアプリ内ルートへ戻す。ハッシュルートとOAuthトークンフラグメントを混在させない。戻り先は同一アプリ内の許可パスだけ。
- API URL、Auth、競技状態取得、通知購読をアダプター化する。UIからDB管理キーやSites APIを参照しない。
- `.openai`、環境ファイル、DB実データ、`.git`、`node_modules`、生成物を既存版から丸ごとコピーしない。必要なソースと静的素材を選んで移す。
- キャッシュを採用する場合は版管理を統一し、古いJSと新しいAPIの不整合を検出する。APIレスポンスや個人成績はService Workerの共有キャッシュに入れない。

### バックエンド

- ブラウザーからの競技データ操作はEdge FunctionsのAPIに集約。JSON、型付きエラー、サーバー時刻、状態リビジョンを共通契約にする。
- 移植する操作: 教員権限確認、設定管理、ルーム作成/参加/再参加、状態取得、準備/manifest取得/ready、開始/中断、operation送信、結果、履歴、許可リスト管理。
- v2の採点・正規化・問題生成をフロントとEdgeで共有できる純粋TypeScriptモジュールへ分離する。Edgeで利用可能な依存のみ使用。
- Postgresへの移植はSQL方言・型・制約・トランザクションを含む。D1のドライバー差し替えだけで済ませない。
- Edgeで状態とrevisionを読み、共通ロジックで再計算し、サーバー専用のcommit RPCに期待revisionと更新案を渡す。RPC内でロック、認可・期限・状態・revisionの再確認、更新、receipt、通知outboxを一括コミットする。
- 競合時は最新状態を読み直して同じ不変リクエストを再評価する。再試行回数を制限し、超過時は再送可能エラー。ブラウザーの集計スコアを保存値として採用しない。
- RPCはservice roleだけ実行可。`SECURITY DEFINER`使用時は固定search_path、明示的な権限剥奪・付与。Edgeだけの古い認可結果で教員剥奪や締切をすり抜けない。
- CORSの許可元は本番Pages originと明示した開発origin。CORSは認可の代用にしない。

## 4. 教員認証と生徒の識別

### 教員

GoogleログインはGoogleアカウントの本人確認であり、教員である証明ではない。学校ドメインだけでも生徒と区別できないため、最初は管理者が登録する許可リストを採用する。

1. 「Googleでログイン」でSupabase Authを経由する。
2. サーバーで検証したユーザー情報から、Google identity・確認済みメール・非匿名ユーザーであることを確認する。
3. 許可リストのメールと照合し、初回成功時にAuth UIDへ関連付ける。以後はUIDと有効状態を確認。メール変更で自動的に別教員へ昇格させない。
4. 許可済みなら教員機能へ。未許可なら「このアカウントは教員として登録されていません」と表示し、管理操作を拒否する。

- 初期マスター教員は利用者指定のGoogleアカウント。GitHubプロフィールのメールから推測しない。
- マスターが教員を追加/停止できる。一般教員は原則として自分が作ったクラスルームのみ管理。Sites版に別の権限がある場合は移植前に差分を明示する。
- `user_metadata`、ブラウザーのメール申告、ボタン表示だけで権限を判定しない。教員ロールはサーバー管理テーブルに置く。
- ブラウザーで職場Googleアカウントにログイン済みでも、最初のアプリログイン操作と必要な同意は行う。複数アカウントでは選択できるようにする。

### 生徒・なかま対戦

- UIは現在と同じルームコード/QRと表示名で参加。裏側でSupabase匿名Authセッションを作り、private channelの認可に使用する。
- 匿名セッションはブラウザー内で再利用し、参加・解答ごとに新規作成しない。既に教員セッションがある端末ではそれを上書きせず、同じUIDの参加者権限として扱う。
- 匿名ユーザーもDBでは `authenticated` roleを持つため、role名だけで教員権限を与えない。
- 既存の高エントロピーな参加者トークン、participant ID、端末復帰の仕組みを維持し、Auth UIDと所属を結び付ける。DBには参加者トークンのハッシュを保存し、URL・ログ・通知に生トークンを出さない。
- セッションだけ失われ参加者トークンが残る場合は、専用復帰APIでトークンの所持を検証し新UIDへ再関連付け可能にする。旧所属を無効化し、通知topicの世代を更新。名前やルームコードだけで参加者を引き継がせない。
- 再参加ではparticipant ID、送信待ちoperation、manifest、writerEpochをむやみに新規作成しない。通常再読込と他端末への書込権移譲を区別する。

### 学校ネットワークで特に必要な設定

匿名サインアップの既定制限は30回/時/IP。学校の共有IPでは42名の初回参加でも超えるため、運用前にSupabaseのAuth設定を調整し、実際の共有回線で確認する。バースト制限も確認する。CAPTCHA等の乱用対策と、学校端末での通過可能性を両方確認する。制限解除だけで放置しない。

匿名Authを利用するため、全体の新規サインアップを無効にして教員を制限する方式は採用しない。教員機能は許可リストで制限する。

## 5. データモデル・アクセス制御

現行 `db/schema.ts` の意味を引き継ぐ。少なくとも次の領域をPostgres migrationで定義する。

| 領域 | 主な内容 |
| --- | --- |
| 設定・教員 | site_settings、設定receipt、teacher_allowlist、管理監査 |
| ルーム | rooms、room_questions、作成receipt、状態revision、所有教員、期限 |
| 参加者 | participants、トークンハッシュ、Auth所属、退出/失効、writerEpoch |
| v2 | room_manifests、participant_progress、operations、batch_receipts、final_fields |
| 成績 | final_results、確定時刻、競技規則と採点版のスナップショット |
| 通知 | room単位のtopic世代、progress revision、durable outbox、配信lease |

- room/participant/manifest/seq/requestIdの複合一意制約、所属外参照を防ぐFK、期限・所有者・検索用indexを付ける。
- application tableはRLS有効。ブラウザーにテーブル全件読み取りや採点テーブル直接書き込みを許可しない。必要な読み取りもAPIで範囲を限定する。
- 問題毎判定の採点情報は本人用manifestに必要な範囲で送る。まとめて判定では確定前の正答・採点結果を送らない。厳格な試験の不正防止を目的としない現行ルールを維持。
- 他教員のクラス成績、生徒のメール、参加者トークン、秘密鍵を通知や公開テーブルに置かない。
- 締切、確定、人数上限、許可リストの変更はDBトランザクションで競合を処理する。
- 保持期間は現行値。期限到来後はアクセスを拒否し、対象データと関連outbox/receiptを整合して削除。匿名Authユーザーには自動削除を期待せず、活動時刻・存続中データ・教員連携を確認する保守処理を別途用意する。
- DBサイズに操作ログ・index・receiptも含めて測定する。監査ログに解答全文や個人情報を無制限保存しない。

## 6. v2競技仕様の維持（必須）

- 状態: `WAITING → PREPARING → COUNTDOWN → RUNNING → COLLECTING → FINISHED`。`CANCELLED`、`EXPIRED`も維持する。
- 準備ではmanifest ID、generation、evaluatorVersionを一致させ、参加者のreadyを待つ。30秒タイムアウトで未準備者を表示し、自動的に開始しない。カウントダウン5秒。
- 同じ競技の参加者には同じ問題と順序。公平な候補抽選、難易度条件、化学的な除外条件を維持する。
- 問題毎判定: ローカル採点、即時フィードバック、正解/パスした欄の確定、誤答再試行、ネットワークを待たない画面遷移。サーバーは同じ入力を再採点する。
- まとめて判定: 下書き・前後移動を維持し、途中の正誤・得点を表示しない。提出確認後は編集不可。未入力を含む提出も扱う。
- ローカル記録はIndexedDBへ保存。キーはroom/participant/manifest。単一writerとwriterEpochで二重タブを扱う。
- operationId、単調seq、requestId、bodyHash、manifest/version/epochを維持。同じrequestIdで異なる本文は拒否。同一本文の再送は同じreceiptを返す。
- 初回operationから最大1秒でバッチ送信（操作が続くたびに無期限延期しない）。下書きは変更時のみ最大5秒、移動/提出でflush。1参加者につき同時送信1本。最大128 operations/128 KiBを維持する。
- 429/一時障害ではRetry-Afterと指数backoff・jitterを尊重。ack前に永続キューを消さない。
- ローカル時刻記録の有限性・単調性・未来値を検証。通信時間を別途減算する古い方式と混ぜない。
- 入力締切 `C = min(deadline, interruptAt)`、収集期限 `U = C + 10秒`。C以後は入力を止め、Uまで締切前の有効操作を回収。U以後は新しい成績変更を認めない。
- 中断時のまとめて判定は中断前の有効な保存済み下書きを使用。未送信の最後の入力が必ず回復できると保証しない。
- 確定は原子的に一度だけ。全員の必要データ受領時は早期確定可能。全体ランキングはFINISHEDで公開。得点降順・時間昇順・同着の扱いを維持する。
- cronの稼働や通知到達だけに確定を依存させない。状態取得/コマンド時にもサーバー時刻で期限を評価し遅延確定できる。
- 教員の走者表示: 問題毎判定は `correctCount / maxScore`、まとめて判定は `answeredCount / maxScore`。問題番号を代用しない。同値の安定順、最大10名、軽量/動きを抑える設定を維持。アニメーションは端末内だけで動かす。

## 7. Realtimeイベント設計

### 方式と通知先

サーバーからのprivate Broadcastを採用する。回答テーブルのPostgres Changesを全員に購読させない。Presenceを参加人数・競技進捗の正本にしない。

| 通知 | 送信先 | 内容・頻度 |
| --- | --- | --- |
| room.changed | 現在のルーム所属者 | 状態/設定/名簿revisionの変更。名簿更新はまとめる |
| room.phase_changed | 同上 | 準備/開始/中断/収集/確定。サーバー時刻と期限、再取得の契機 |
| host.progress | 所有教員、必要なら認可済み主催者 | 採点方式に応じた進捗。ルームごと最大1回/秒に集約 |
| 自分の送信ack | HTTPの呼出元 | operation受付結果。全員にbroadcastしない |

topic例: `room:{opaqueId}:control:{epoch}` と `room:{opaqueId}:host:{epoch}`。推測しにくいIDだけに認可を頼らない。Payloadは小さく、正答・解答全文・認証情報を含めない。教員進捗は許可された参加者IDと必要な集計値だけ。生徒には競技中の全員の成績を送らない。なかま対戦の主催者権限は現行APIが認める範囲に限定する。

全イベントにeventId、roomId、topicEpoch、関連revision、発生時刻を含める。progress revisionとroom状態revisionは別管理し、全解答がroom行の共通ロックを不必要に競合させない。

### 配信と通信量の抑制

- DB更新と通知outboxの登録を同じトランザクションで行い、コミット後に送る。通知失敗で受付済み解答を巻き戻さない。
- 進捗outboxはroomごとの最新状態へ集約。複数EdgeインスタンスでもDBのlease/送信時刻管理で一重にflushする。
- 通常はコマンド完了後にflush。`waitUntil`は補助にできるが、そこでのタイマー実行だけを配信保証にしない。後続コマンドと教員の安全確認リクエストでも未送信outboxをflushする。
- RUNNING/PREPARING/COLLECTING中の教員画面は2秒間隔の安全確認を残す。これが最後の集約イベントの回収と通知断時の表示更新を担う。WAITINGは5秒、生徒は接続正常時30秒を基準にする。非表示時は頻度を落とし、復帰直後に取得する。
- Freeの100 messages/秒は受信者への展開分も考慮する。全プロジェクト共通の送信予算を設け、初期目安70 messages/秒（送信1＋受信者数で見積もる）として余裕を残す。制御通知を優先し、進捗を集約/遅延する。実測の管理通信も見て調整。
- 参加者数と追加タブを保守的に見積もる。アプリ側予算だけで実際のSupabase上限が絶対に守れるとは扱わない。制限エラー時は再接続連打を止めHTTP確認へ移る。
- タブ内のSupabase clientとsocketは1つ。画面変更で古いchannelを解除し、終了後の不要な接続を閉じる。別タブや投影専用端末は追加接続として数える。
- キー入力・毎フレーム・残り時間の秒刻みを配信しない。カウントダウンとレース描画はサーバー時刻との差分から端末内で表示する。

### 整合性と復旧

- 通知は更新の合図でありDBが正本。受信時刻を採点時間や締切に使わない。
- 初回はchannel購読成功後にsnapshotを取得する。取得中の通知を一時保持し、revisionを比較して必要なら再取得する。
- 重複・古いイベントを無視し、revision欠落・再接続・前面復帰時に再同期。差分だけで復元できない時はsnapshotを取得する。
- 通知由来の再取得はまとめ、同時HTTPを増殖させない。教員進捗イベントに十分な集計値があれば描画に使い、毎イベントで別GETしない。
- 切断時は教員2秒、生徒5秒を基本としたjitter付きHTTP確認へ切替。障害が続く時はbackoff。正常復帰後に低頻度へ戻す。
- 開始時刻・締切・収集期限には端末タイマーでもAPI再確認する。通知が失われても時間超過入力や永久COLLECTINGにならない。
- 通常時の目標はコミットから画面反映まで概ね1〜2秒。受入時は測定条件とp95を記録し、ローカル送信バッチ待ちとサーバー反映時間を分ける。ネットワーク障害時の保証値とはしない。

### private channelの権限

- Realtimeのpublic accessを無効化し、`realtime.messages`のRLSで所属・教員所有権・topic世代を検証してSELECTだけ許可。クライアントから公式イベントをINSERT/Broadcast送信させない。
- Realtime権限は接続中にキャッシュされるため、DBで教員/所属を無効化するだけでは購読停止の即時性を保証できない。
- 除名・教員停止・所属再関連付け時は関連topicのepochを更新し、旧topicへ新情報を配信しない。APIは直ちに拒否。権限のある端末は定期確認で新topicを取得して再購読する。
- 成績詳細など機微情報は通知に載せず、APIで毎回認可する。停止済み端末が保持済み情報を見ることまで取り消せるとは扱わない。

## 8. 無料枠の評価と運用条件

2026-10-01に公式資料で確認した値。実装・公開時は対象組織の現在のプラン/使用量と再照合する。

| 項目 | Freeの枠 |
| --- | --- |
| Realtime同時接続 | 200 |
| Realtimeメッセージ速度 | 100/秒 |
| Realtimeメッセージ量 | 200万/請求サイクル |
| Edge Function呼出 | 50万/請求サイクル |
| Auth MAU | 5万人 |
| DB | 500 MB/プロジェクト |
| Egress | 5 GB/請求サイクル |

月間等の利用枠には組織内の他プロジェクト分も関係する。DB・接続数のようなプロジェクトの制限と分けて確認する。

### 同時利用

| 満員クラス数 | 生徒42名＋教員1名/クラス | 判定 |
| --- | ---: | --- |
| 1 | 43接続 | 無料で試す現実的な規模 |
| 2 | 86接続 | 初期運用の推奨範囲。実測確認が必要 |
| 3 | 129接続 | 接続枠内だが速度・月間枠も評価 |
| 4 | 172接続 | 追加画面・再接続時の余裕が小さい |
| 5 | 215接続 | 200を超えるため全員Realtime接続は不可 |

教員5名が時間を分けて使う場合と、5クラス同時に使う場合は違う。人数だけから「問題なく使える」と保証しない。5クラス同時を通常運用にするなら有料プラン等を検討する。ポーリングへの縮退は授業を止めないための補助であり、5クラスの安定動作の保証ではない。

### 月間量の試算方法

Broadcastは「送信1＋受信したクライアント数」で数える。

- 42名×30解答欄＝1,260回の更新を43端末全員へそのまま送ると、1,260×44＝55,440 messages/対戦。
- 同じ更新を教員1端末だけへ送れば1,260×2＝2,520。全員向け制御通知を仮に12回とすると12×44＝528、合計3,048。これは説明用の単純計算であり、再送・名簿・準備・誤答反復・追加画面は別。
- 本仕様の進捗集約では削減が期待できるが、実測前は1対戦5,000〜10,000 messagesの予算を仮置きする。5教員×1対戦/日×20日＝100対戦なら50万〜100万、4対戦/日なら200万〜400万となり無料枠を使い切る可能性がある。
- Edge呼出は別の制約。5分の対戦で生徒30秒確認なら42×10＝420回、教員2秒確認は150回。仮に更新1,260回＋準備等200回なら約2,030回/対戦。100対戦で約20.3万回。
- まとめて判定で全員が5秒ごとに下書きを更新し続けると42×60＝2,520回。上記の確認等を加えると約3,290回/対戦、100対戦で約32.9万回。待機時間、誤答、再送、10分設定、障害時ポーリングなどで増えるため、これは上限値ではない。
- egressはmanifest・snapshot・履歴・通知の実バイトを測る。静的JS/画像はPages配信にし、Supabase転送量を消費するものと分ける。

結論: **教員5名、同時1〜2クラス、控えめな対戦回数なら無料で試す価値が十分ある。5クラス同時や毎日何度も全員が使う運用は無料前提で確約しない。**

### 無料運用の受入条件

- 初期は1クラス、次に2クラスで接続数・messages/秒・1対戦のmessages/Edge/egress・DB増加を測る。
- 管理者用の運用資料に月間推計を記録。枠の50/70/85%を点検目安にし、Supabase Dashboardの実値を確認する。アプリだけで課金枠を正確に把握できるとしない。
- 無料プロジェクトは低活動が約7日続くと停止対象になり得る。長期休暇後は授業前に管理画面と実アプリで起動確認。自動バックアップを前提とせず、必要な結果は保持期間内に保存できる運用にする。
- 有料化、追加プロジェクト作成、データ削除は実装判断だけで実施しない。

## 9. 利用者に必要な準備・情報

仕様作成にはアカウント情報は不要。実装で外部設定が必要になる時点で、次を確認する。

1. 使用するSupabaseプロジェクト（未作成なら作成先組織・Free・リージョンは東京を第一候補）。既存プロジェクトの用途・使用量を確認する。
2. Project URL / project ref / publishable key。publishable keyはブラウザー向け公開設定。RLSが前提。
3. 初期マスター教員のGoogleメールと、最初に利用を許可する教員メール。
4. Google CloudのOAuth設定を行えるアカウント/プロジェクト。Google OAuth client ID/secretをSupabase管理画面で設定する。
5. Googleの許可originは `https://koichem.github.io`、OAuth callbackは当該Supabaseが指定する `https://<project-ref>.supabase.co/auth/v1/callback`。Supabase側の許可redirectにPagesの正確なbase URLを登録する。開発URLは別途明示。
6. Googleの公開/テストユーザー設定と、学校側の外部アプリ利用制限を確認。最小限のopenid/email/profileを使用する。
7. backendのデプロイ認証は公式CLIログインや適切なGitHub Actions secretsで設定する。

パスワード、DB接続パスワード、service role/secret key、OAuth client secretをチャットに貼ってもらわない。必要なら本人が管理画面や秘密情報ストアへ入力する。フロントのビルド環境に管理キーを設定しない。

SafariでのSupabaseログインやGitHub連携は管理画面を使う準備にはなるが、アプリのGoogle OAuth設定完了を意味しない。

## 10. Solの実装順序と完了条件

1. 現行版の基準と移植対象を記録し、Gitの独立性・リモート内容を確認する。
2. 静的SPAと共通競技モジュールを作り、Pagesのbase/ルーティング/資産参照を成立させる。
3. Postgres schema・RLS・原子的commit RPC・期限処理・認可APIを実装する。
4. Google教員認証、許可リスト、匿名参加、既存トークンによる復帰を接続する。
5. v2競技を移植し、通知なしでも正しく競技・確定できる状態を作る。
6. private Realtime、集約/outbox、復旧/権限失効、使用量計測を追加する。
7. 下記受入項目を検証し、実装・検証結果と外部設定の未完了部分を記録する。
8. 公開が依頼された段階でbackendを先に適用、Pagesをデプロイし、公開URLで別途検証する。今回の仕様作成依頼だけでは公開しない。

### 実装時の受入検証

| 分野 | 必須ケース |
| --- | --- |
| 教員 | 許可/未許可Google、匿名の昇格拒否、停止済み、他教員ルーム操作拒否 |
| 生徒 | 学校共有IPの42/86名初回参加、人数超過、同名、QR再参加、再読込、二重タブ、セッション喪失復帰 |
| 競技 | 両判定方式、準備待ち、開始、中断、期限、全員提出、同着、未入力、通信断・再送 |
| DB整合性 | 二重開始/参加/確定、同seq競合、同request別body拒否、CAS競合、終了後の遅延解答拒否 |
| Realtime | 他room/host topic拒否、クライアント偽通知拒否、欠落/逆順/重複、切断復帰、教員停止後の旧topic配信停止 |
| 規模 | 1/2クラスの接続・一斉ready・一斉解答・同時開始・結果確定、瞬間速度と月間換算 |
| UI | PC/iPad/スマートフォン、タッチ用入力、日本語、QR、戻る、レース軽量表示、結果/履歴 |
| Pages | base付き直リンク/再読込、OAuth復帰、静的資産、更新後のキャッシュ互換性 |

純粋関数・API/SQLの検証と、Playwright MCPによるブラウザーの画面/操作/console/network確認を分けて記録する。外部Googleログイン、実SupabaseのRLS/Realtime、実学校回線、物理iPadのタッチやキーボードはモックやデスクトップ検証で代替済みとしない。

大量接続はまずローカル/専用検証環境で行い、本番の負荷確認は利用状況・枠への影響を確認してから小さく開始する。接続枠内でも性能が十分とは限らない。

リリース時はGitHub MCPのCI/Pages状態と実配信ページの確認を区別する。DB migrationは可能な限り後方互換にし、前版Pages artifactへ戻せるようにする。破壊的DB変更をロールバック手順と呼ばない。

## 11. 公式資料

確認日: 2026-10-01。仕様の計算・運用案は本アプリ向けの設計上の見積もりであり、Supabaseの性能保証ではない。

- [Realtime limits](https://supabase.com/docs/guides/realtime/limits)
- [料金・使用量の枠](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Realtime messagesの数え方](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages)
- [Private Realtimeの認可](https://supabase.com/docs/guides/realtime/authorization)
- [Broadcast](https://supabase.com/docs/guides/realtime/broadcast)
- [Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [匿名Authと制限・保守](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits)
- [Freeプロジェクトの停止](https://supabase.com/docs/guides/platform/free-project-pausing)
- [料金プラン](https://supabase.com/pricing)
