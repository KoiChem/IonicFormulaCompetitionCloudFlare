# ホスト開始タイムアウト改善仕様 — Sol 実装用

状態: 調査・仕様作成まで。追加実装・コミット・公開は未実施。
対象: `IonicFormulaCompetitionGitHub` / GitHub Pages + Supabase。
基準コミット: `1ac37a427ec5ee06e415c51345ed408f89487181`。
前提: ワークツリーには直前の参加タイムアウト対策が未コミットで存在する。これを保持して実装する。旧 `IonicFormulaCompetition`（Sites）には変更しない。

## 1. 結論と目的

前回の変更だけでは、ホストの開始タイムアウトは解決していない。参加通知の削減は開始までの混雑を間接的に緩和するが、開始応答の消失・遅延からの復旧と、開始を妨げるバックエンドの待ちを扱っていない。

授業中に20人程度が参加した直後でも、ホストが開始結果を見失わず、一度だけ問題を準備し、全員準備完了後に同じ開始時刻へ進めることを目的とする。既存上限42人も回帰検証する。

「開始要求を確認中」「問題配信・参加者の準備待ち」「カウントダウン」「通信状態が不明」を区別する。応答の時間切れだけで失敗と決めない。一方、未確認の状態を成功とも表示しない。

## 2. 調査結果と証拠

### 2.1 開始済みなのに時間切れ表示することを再現

現在の未コミット修正版を、Playwright MCP、ローカルPGlite API、独立したホスト・生徒のブラウザーで検証した。15問のクラスルームを作成し、一人を参加させた。POST `/start` はサーバーまで実行した後、初回・再送とも応答を11.5秒遅らせた。

ホストに `通信が時間内に完了しませんでした` のalertが出た。その後の正規API照会は `room.state=RUNNING`、`preparationGeneration=1`。ホストはレース、生徒は第1問を表示していた。開始は一度成功しているのに、送信処理だけが失敗を告知する不具合である。

通常の一人参加が遅いことを示す計測ではない。応答遅延を注入したときの整合性・復旧の再現であり、当日の学校回線の原因確定とは区別する。

### 2.2 確認した実装上の問題

| 箇所 | 現状 | 影響 |
|---|---|---|
| `RoomScreen.tsx` の `retryExact` とクラス・メイトの `start` | 10秒POSTを一度再送し、再失敗ならalert。押し直すと新しいrequestId | コミット済みか確認しない。再読込後に開始要求を復元できない |
| `useRoomSync.ts` の `postJson` / `fetchJsonWithTimeout` | 10秒は認証セッション取得から応答読取まで。端末でabortしてもサーバーの取消契約はない | 画面側の時間切れとサーバーの成功が両立する |
| `ParticipantRoom` と `CompetitionPlayer` / `CompetitionPlayerV2` | 親子それぞれが `useRoomSync` を起動 | 生徒一画面に2系統のポーリング・購読・状態取得。前回のcoalesceは各hook内だけ |
| `postgres-runtime.ts` | isolate内の接続上限1。同一roomスコープは全要求でadvisory lock取得 | GET状態照会、参加、開始、問題取得、readyが同じ待ち列に入る。max=1はプロジェクト全体1接続という意味ではない |
| `realtime-outbox.ts` | 通知を送る外部HTTPをroomロックとDBトランザクション内でawait | 通知が遅いと、その間の開始・参加・readyが進めない。送信の上限は一件3秒 |
| `edge-entry.ts` | 通知は `waitUntil` だが、同じDB実行器を使用 | 応答後処理にしただけでは接続・ロック競合は解消しない |
| `PostgresDatabase.batch` | 各statementを順にawait | 15問を個別INSERTし、DB往復が増える |
| `http.ts` のstart | receipt確認は永続化関数内。そこまでにprofile読込・問題生成が済む | 成功済み要求の再送でも不要な仕事を繰り返す |
| `markV2Ready` | 準備開始から30秒未満で全員がreadyの場合のみCOUNTDOWNへ進む | 開始POSTの時間切れとは別。30秒を過ぎて全員readyになっても自動開始しない |

ローカルの20人・15問・マスター教員・v2 immediateの固定fixtureで、Gatewayが発行するSQL呼び出しを計測した。状態取得23回、初回開始45回、同一要求の再送20回だった。開始・再送は同一manifestとgeneration=1を返した。この回数にAuthのHTTP、BEGIN/COMMIT、runtimeのSET/lock、背景通知は含まない。実DBの往復時間を測った数字ではない。

### 2.3 未確認事項

本番Auth時間、pool接続待ち、advisory/row lock待ち、SQL時間、通知送信時間、学校回線の損失率は未計測。本セッションにSupabaseログを取得する専用MCPは見つからず、本番ログ取得はしていない。GitHub MCP・Playwright MCPの接続は確認済み。

ローカルAPIはGoogle AuthとRealtime実サービスを再現しない。WebSocket 404によるHTTPフォールバックでのUI再現である。前回の20ブラウザー成功も本番性能保証にはならない。

## 3. 選択する方針

候補を比較し、Bを採用する仕様案とする。

| 案 | 利点 | 問題・判断 |
|---|---|---|
| A: POSTの時間制限だけ延長 | 変更が小さい | 待ち列、二重同期、成功後の応答消失が残る。不採用 |
| B: 開始要求の結果照会＋同期一本化＋通知の外部送信をDBから分離＋開始SQL削減 | 原因側の負荷と表示不整合を両方扱える。既存receiptを利用可能 | クライアント・Gatewayの変更が必要。推奨 |
| C: 開始を永続ジョブキューへ移行して202応答 | 長時間処理へ拡張しやすい | ワーカー停止・再実行・受付状態の管理が増える。今回の開始処理には過大。保留 |

`waitUntil`を永続ジョブの代用にはしない。背景処理にもworkerの実行上限がある（[Supabase公式](https://supabase.com/docs/guides/functions/background-tasks)）。roomトランザクションの排他を無条件に外さない（[PostgreSQL公式のロック仕様](https://www.postgresql.org/docs/current/explicit-locking.html)）。

## 4. 必須仕様

### 4.1 開始要求を保存し、一意に追跡する

クラス・メイト両ホストで共通の開始コントローラーを使う。

- 送信前に `{requestId, expectedRevision, requestedAtMs, protocolVersion, roomId, ownerKey}` をlocalStorageへ保存する。キーはアプリ・room・所有者単位。トークン・メール・解答は保存項目に追加しない。
- 保存失敗時は送信しない。「開始要求をこの端末に保存できません」を表示する。
- 同じ未確定要求ではrequestIdとbodyを変えない。二度押し・再読込・再接続・同一ブラウザー別タブで同じ要求を復元する。Web Locksを使える環境では作成・送信を同じキーで直列化し、使えない環境でもサーバーのrevision/receiptで二重準備を防ぐ。
- 未確定の開始がある間は新しい開始ボタン、設定変更、準備取消と競合する送信を無効化する。既にPREPARINGへ進んだと確定した後は、通常の準備取消UIを使用できる。
- local draftと現在の所有者が違う場合は再送しない。ログアウト・権限喪失後の再送を禁止する。

画面状態は `idle / submitting / checking / confirmed / rejected / unresolved` とする。30秒の準備期限とは独立した状態である。

### 4.2 開始応答の時間切れ後は結果を確認する

- 初回POSTは現行10秒を維持する。timeout・ネットワーク例外・408・429・5xx・database_conflictは結果不明として扱い、すぐに二本目のPOSTを送らない。
- 成功応答はreceiptの確定結果として扱い、通常の最新状態取得へ進む。成功応答後の画面refreshだけが失敗した場合も「開始失敗」のalertを出さない。
- 不明時は下記 `start-status` を照会する。画面表示は「開始状況を確認しています…」。モーダルalertは禁止。
- 初回POST後、状態照会は同時一本、開始間隔を1秒→2秒→4秒→以後5秒とし±20% jitterを付ける。429はRetry-Afterを優先する。照会一回の上限は5秒。
- 未確定状態で、直近の結果がreceipt未検出かつroomがWAITING、かつ最初のPOST完了から2秒以上経過していれば、同じbodyの自動再送を一回だけ許す。自動POSTは合計最大2回。receipt未検出は元の要求の不在・取消を証明しないので、再送は必ず同じrequestIdで行う。
- 送信開始から30秒で確認できなければ `unresolved`。「開始結果をまだ確認できません。参加者画面も確認し、開始状況を再確認してください」を表示。新規requestIdを作らず、5秒以上の間隔で軽量照会を継続し、手動「開始状況を再確認」を提供する。非表示時は30秒間隔、offline時は停止してonlineで照会する。終了・権限喪失・画面離脱で停止する。
- roomがPREPARING/COUNTDOWN/RUNNING/COLLECTING/FINISHEDなら開始済み状態を画面に反映する。自分のreceiptが無い場合は「別の操作で開始済み」と扱い、自分の要求を成功したことにはしない。追加POSTは止める。
- receiptが存在しても、その後の取消でroomがWAITINGになっていることがある。過去のPREPARING結果を現在状態に上書きしない。「前の開始は取り消されています」と表示し、明示操作によってのみ新しい要求へ進む。
- 401/403は認証・権限確認へ。expired/not_found/CANCELLED/EXPIREDは終了扱い。requestIdのbody不一致は自動復旧禁止。
- stale revision / invalid_stateはまず結果照会する。WAITINGで確定拒否なら最新名簿・設定を提示し、利用者の再操作で新規requestIdを作る。revisionを自動で最新値へ差し替えて開始しない。
- 後から届いた古いPOSTの例外は、既に確定した開始・取消・別generationの画面をエラーへ戻さない。コントローラー自身の世代番号で無視する。

### 4.3 軽量な開始結果照会API

新設: `GET /api/rooms/:publicId/start-status?requestId=<uuid>`。

認証済みの当該ホストだけ利用可。classは現在許可されている所有教員、mateは現在有効なホスト参加資格。CORS、認証、期限、所有者確認、UID単位のレート制限を維持し、ブラウザーへDB直接権限を与えない。

返却契約:

```ts
type StartStatus = {
  requestId: string;
  receipt: null | {
    protocolVersion: 1 | 2;
    roomRevision: number;
    manifestId?: string;
    preparationGeneration?: number;
    processedAtMs: number;
  };
  room: {
    state: RoomState; // 現在の有効フェーズ
    revision: number;
    startAtMs: number | null;
    expiresAtMs: number;
    manifestId: string | null;
    preparationGeneration: number | null;
    preparationTimedOut: boolean;
  };
  serverNow: number;
};
```

- v2 receipt actorは既存 `v2-prepare:${internalRoomId}`、v1は既存 `room:${internalRoomId}` を使用。任意actorを受け付けない。requestId形式と長さを検証する。
- receipt=nullの意味は「この読み取り時点ではコミット済みreceiptを観測していない」。`failed`や`not_started`と命名しない。
- 現在roomとreceiptは同じ読み取りスナップショットで返す。未コミットの書き込みや未確定生成物を返さない。
- この経路はroomの排他ロックを取らない。状態遷移、期限切れ削除、membershipの再割当、教師bindingの作成、fingerprint生成、outbox作成・flushを実行しない。
- `transact('read:...')` と文字列だけ変えても既存runtimeはロックを取るので不可。明示したread-only実行経路を実装する。
- 通常APIの認証ロジックを再利用しても、teacherProvider内のINSERT/UPDATEを読み取り経路へ持ち込まない。所有者・active binding・現在のallowlistを読み取りで再検証する。membershipを再割当しないため、再割当が必要な場合は通常の復帰経路へ案内する。
- レート制限は短い独立トランザクションで判定する。通常コマンドも同じUIDのquota行を長いroomトランザクション中に保持しないよう分離し、結果照会が開始要求のquota行待ちで止まることを防ぐ。課金・認証失敗時も無制限に通さない。
- 接続待ちも分離する。初期構成は通常コマンド/背景DB処理用max=1と結果照会用max=1の二つの上限制御されたpoolとする。両方とも既存Transaction poolerを使う。全isolateの接続予算を負荷試験で確認し、無制限増設や直接DB接続への戻しは禁止。
- 既存の`state`をそのまま呼ぶ実装は不可。軽量照会のDB部分はroomロック保持中でも終了できることを実PostgreSQLで検証する。

### 4.4 生徒画面の状態同期を一本化する

`RoomScreen`配下にroomId＋資格に結び付く一つの同期Providerを置き、`ParticipantRoom`、v1/v2 player、mateホスト表示が同じdata・clock・refresh・Realtime購読を使う。子で別の`useRoomSync`を起動しない。必要なら既存hookを内部実装と公開Contextに分ける。

- 一タブ・同一room資格で状態ポーリング一本、control購読一本、権限がある場合だけhost購読一本。
- tokenやroom切替時に古い購読・timer・未適用responseを無効化する。異なる資格間でsnapshotを共有しない。
- 前回追加したcoalesceと「更新通知後には後続の新しいGETを確保する」性質は維持する。
- WAITINGの初回は一回の状態取得にする。undefined→WAITINGの描画更新だけで二回目を発行しない。COUNTDOWNの追加時刻サンプルは共有時計に対して一組だけ。
- polling、Realtime、visibility、mutation後のrefreshを同じ制御へ通す。
- 生徒はPREPARING通知で速やかにmanifest取得→IndexedDB保存→readyへ進む。自動readyは保存成功後のみ。ready待ち30秒を各再試行ごとにリセットしない。

### 4.5 通知の外部HTTPをDBトランザクションから外す

必須条件: `await send(...)`中にDB接続・トランザクション・room/advisory/row lockを保持しない。接続を増やすだけで代用しない。

現行は権限剥奪後に古いtopicへ名簿等を送らないためロックしている。送信だけ外へ動かすとその保証を壊す。今回の推奨方式は、control/hostとも通知本文を「更新がある」という非機密な無効化通知に限定すること。

- ペイロードは `eventId, roomId, epoch, revision, roomRevision` のみ。名前・人数・順位・成績・問題・解答・開始時刻・フェーズは送らない。
- hostは通知をまとめて認証付き`state`を取得する。連続host通知による取得は最大2秒に一回、取得中は後続一回にまとめる。開始等のcontrol通知・明示操作はこの2秒待ちを適用しない。参加者の名簿変更でcontrol通知を再導入しない。
- phase/settings/epoch変更のcontrol通知は全員へ即座に無効化を知らせる。内容は認証付きAPIから取得する。
- claimは短いDBトランザクションでleaseとfanout予算を確保し、commitする。送信前に必要なepoch確認を短く行い、commit後にHTTP送信する。送信後は別の短いトランザクションでackする。
- claim後に権限剥奪が競合した場合、旧topicへ届く可能性は無内容の通知に限定される。APIは必ず最新権限を再検証してデータを拒否する。この変更をprivacyテストに含める。
- 古い形式で保存されたoutboxも、送信直前に許可フィールドだけからペイロードを構築する。既存payload_jsonをそのまま送信しない。
- ack/deleteはroom、kind、eventId、leaseIdの一致を条件にする。古い送信成功で新しい通知を削除しない。lease期限・revision・epochが異なる場合のsent時刻更新も新通知を誤って抑止しないよう条件化する。
- failure時は該当leaseだけ解放し、DBに残ったoutboxを次の起動で再試行する。応答成功を通知成功に依存させない。
- isolate内で同一roomのflushを一本にまとめる。新イベント到着中はdirtyフラグを立て、現在のflush後にもう一度確認する。worker間の重複はDBのleaseで防ぐ。
- `waitUntil`は通知送信にだけ使用し、開始要求のcommitを背景処理へ移さない。

互換性: 既存clientのhost handlerはparticipantsが無い通知をresyncに回すので移行可能。ただし旧clientは取得頻度が多いため、新画面への更新案内と混在負荷試験が必要。

### 4.6 開始のクリティカルセクションを短くする

- 認可と入力/bodyHash検証後、問題生成前に既存開始receiptを調べ、同一bodyなら確定結果を返す。不一致なら既存のrequest_id_reusedを返す。
- 初回開始の問題生成・保存・manifest更新・progress初期化・receipt保存の原子性を維持する。問題生成の一部だけ確定させない。
- room_questionsの保存は5/10/15問を一つのパラメーター化INSERTにまとめる。推奨は既存のJSON配列展開互換層（SQLite json_each / PostgreSQL jsonb_array_elements）を使う静的SQL。number型のcastとJSON文字列二重エンコードに回帰テストを付ける。
- 汎用batchを無条件にPromise.allへ置き換えない。既存SQLは順序・marker・変更件数に依存する。
- startのGateway後処理で未使用のtopicsForを実行しない。topicsはstate/realtime等、本当に返却する経路だけで取得する。認証membership処理の省略は目的と認可条件を精査して行う。
- 同一requestId再送でgenerationやstartAtを増やさない。cancel後の新要求でも既存の問題再利用ルールを維持する。
- `prepared_at_ms`は長いロック待ち・問題生成・問題INSERTより後、開始トランザクション終端近くのサーバー/DB時刻で設定する。最後のreadyでも、COUNTDOWNのstartAtはロック待ち以前の受信時刻ではなく、COUNTDOWN更新直前の時刻＋5秒とする。その後に外部I/Oを挟まない。30秒準備時間や5秒カウントダウンを処理待ちで消費させない。実DBのcommitに要した残余時間は計測に含める。
- 一般のstateは期限確定等の書き込みを含むため、単純なロック除去は今回の方式に含めない。負荷基準を満たさない場合は「通常読取と期限遷移の分離」を追加設計し、タイムアウト延長だけで完了扱いにしない。

### 4.7 準備30秒の表示と回復

今回、競技ルールとしての準備30秒・カウントダウン5秒は維持する。

- `preparationTimedOut`は「開始要求の通信タイムアウト」と明確に区別する。
- 全員未準備の名前と人数、準備開始からの状況をホストに示す。
- 30秒超過後は「問題の準備が揃いませんでした。通信状態を確認し、準備を取り消して再度開始してください」と案内し、既存取消→WAITING→新しい開始の手順を提供する。取消の確認が済むまで新generationを開始しない。
- 期限超過で自動的に参加者を除外したり、未準備のまま強制開始したりしない。
- manifest取得/ready失敗は同じgenerationで有限の間隔を空けて再試行。取消後の古いreadyを採用しない。

## 5. 計測と受け入れ条件

### 5.1 診断ログ

request ID、route、protocol、totalMs、authMs、poolWaitMs、roomLockWaitMs、dbWorkMs、queryCount、responseStatus、SQLSTATEを構造化して記録する。SQL文別は静的な分類名と時間に限定する。トークン・メール・名前・問題本文・解答・body全体は記録しない。開始・失敗は全件、通常状態照会はサンプル化する。

通知はclaimMs/sendMs/ackMsと成功・失敗分類を別ログにする。`AbortSignal`、pool待ち、lock待ち、statement timeoutを同じ503だけに潰さない。利用者に秘密情報や生SQLは出さない。`x-request-id`を実際に付与して調査に使えるようにする。

### 5.2 必須テスト

1. 20人/42人、5問/15問、immediate/deferredで、参加直後の開始→manifest→保存→ready→COUNTDOWNを検証。
2. 開始POSTをcommit後に10秒以上遅延/応答破棄。状態照会で成功へ復帰し、誤ったalertなし、generationとmanifestは一つ。
3. 開始POSTがまだ未コミットの間にstart-statusを読む。receipt=nullを失敗扱いせず、同じ要求を保持。
4. 開始成功後の通常refreshのみ失敗、ページ再読込、ネットワーク復帰、二度押し、複数タブ、別ホスト操作、権限取消を検証。
5. 参加者増加でexpectedRevisionが古いケースでは、設定を自動で読み替えて開始せず、確定状態を表示して再操作を待つ。
6. 開始commit→準備取消→古いPOST応答/receipt到着の順でも、PREPARINGへ戻らない。
7. 生徒一タブの同期・購読が実際に一本。待機初回GET一回、COUNTDOWN追加サンプル一組。取得途中のcontrol通知で後続の新GETが発生する。
8. 通知senderを3秒停止しても、DBトランザクションが開いたままにならず、別のstart/readyとstart-statusがそのHTTP完了を待たない。実PostgreSQL＋postgres.jsを使い、同一isolateのpool待ちと複数workerのlock待ちを分けて確認する。
9. 通知claim後にremove/rebind/教員取消。旧topicへ機密情報なし、API権限は拒否、新eventを旧ackで消さない、送信失敗後に再通知可能。
10. bulk INSERT途中の制約違反で開始全体rollback。同一要求再送、異なるbody、cancel後再開、v1既存ルームも回帰確認。
11. 準備期限29.9秒/30秒/30.1秒、古いgenerationのready、IndexedDB保存失敗では一貫した挙動。
12. Pages/Edge新旧組み合わせで最低限の互換性を確認。新UIでstart-statusが404なら同じrequestIdを保持し、通常stateによる控えめな確認へfallback。新requestIdを乱発しない。

PGliteの直列テストだけで接続プール・advisory lock性能を合格扱いにしない。負荷試験は使い捨ての検証DBで行い、本番へ無断で42人の試験データを作らない。

### 5.3 性能の合格目標（測定条件付き）

測定環境・Auth有無・Realtime有無・cold/warm・DB/Edge地域を記録する。現状の達成値ではなくSolが実装後に判定する基準である。

- warmの検証環境、20人同時参加直後、DBクエリ往復相当の追加遅延10ms、API往復200msの固定注入条件で、開始POSTの95%が5秒以内、全件が10秒以内。30回以上の独立試行で測る。
- 同条件42人でも開始POSTの時間切れ・ロック時間切れゼロ。最後のreadyからCOUNTDOWN確定まで2秒以内。
- 最終参加が確定済みで、端末保存が成功しネットワーク断が無い場合、開始受付から全員readyまで20人は15秒以内、42人は25秒以内。30秒の準備期限に余裕を残す。
- 通知3秒遅延注入時、開始遅延がその3秒分増えないことを待ち依存関係のテストで確認する。単なる平均値比較だけにしない。
- 結果照会のDB部分はroom書き込みのロックを継続保持していても1秒以内に読める。Auth/ネットワーク別の失敗は結果不明として安全に表示。
- 本番での20台検証が未実施なら、その制限を公開報告に残す。上記を満たさない場合、接続数増量・time limit延長だけで完了宣言しない。

## 6. Solへの実装順序と変更対象

1. 現ワークツリーと既存の参加対策を確認し、消さずに基準化する。まず開始応答消失・二重同期・通知送信中のロックを再現する回帰テストを書く。
2. 診断情報とread-onlyのstart-status経路、quota分離・上限制御poolを作る。
3. 開始要求の保存・復旧コントローラーとクラス/メイトの表示を実装する。
4. room同期をProviderで共有し、親子の二重同期を除く。
5. 通知を無内容の更新通知へ変え、claim/send/ackを分離。dirty/lease/epoch競合を検証する。
6. 開始receiptの早期確認、問題のbulk INSERT、不要なtopics読込の削減。
7. 全テスト・型検査・build・Edgeバンドル・実PostgreSQL負荷試験・Playwrightを実施し、条件別に結果を記録する。
8. 独立レビューを受ける。公開は別途ユーザーの承認後。Supabase APIとPagesの両方を更新し、公開版の新規ルームで確認する。

主な変更候補:

- `src/features/lobby/RoomScreen.tsx`、`Lobby.tsx`、開始専用controller/draftの新規モジュール
- `src/features/play/useRoomSync.ts`、v1/v2 player、同期Provider
- `src/platform/http.ts`、`supabase-gateway.ts`、`postgres-runtime.ts`、必要なread-only認可処理
- `src/platform/realtime-outbox.ts`、`edge-entry.ts`、`src/web/realtime.ts`
- `src/persistence/v2-manifest.ts`、v1互換の開始保存処理、関連Postgres互換テスト
- `supabase/functions/competition/index.ts`（生成物）
- 既存Postgres/API/UIテスト＋実PostgreSQLで動く通知競合・負荷テスト

receiptは既存テーブルを使い、新たな永続ジョブテーブルは不要。DB migrationが本当に必要になった場合は理由・互換性・rollback方針を明示する。共有教員認証、採点、保存期間、ルーム人数上限、課金プランは変更しない。

## 7. 公開時の確認と境界

バックエンドを先行して更新し、既存UIが動作することを確認後、Pagesを公開する。start-statusの未対応fallbackと旧通知payload処理を含めて段階更新を安全にする。

性能問題の戻し先は、まず変更前の動作へ戻せるcommitとEdgeバンドルを記録する。ロールバックのために競技データを削除しない。既存試合・解答・結果と旧requestIdのreceiptを保持する。

本仕様作成ではアプリ実装・DB・本番公開は変更していない。前回の参加対策は未公開のまま。この仕様の実装開始には別途指示が必要である。
