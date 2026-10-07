# IonicFormulaCompetition Cloudflare移植 — sol向け実装仕様

作成日: 2026-10-08 JST\
状態: 調査に基づく実装仕様案。今回行ったのは文書化のみ。実装・push・クラウド設定変更・公開は未実施。

## 1. 目的と作業境界

既存の教材・競技・日本語UI・操作感を維持し、バックエンドをCloudflare Workers / D1 / Durable Objectsへ段階移植する。単なる配信先変更ではなく、Cloudflareの実行環境、原子性、通信回数、利用量に適した実装にする。

**実装先は `KoiChem/IonicFormulaCompetitionCloudFlare` に限定する。**

- GitHub: https://github.com/KoiChem/IonicFormulaCompetitionCloudFlare
- ローカル作業先: `/Users/ikemon/Documents/codings/GitHub/chem/IonicFormulaCompetitionCloudFlare`
- 参照元GitHub: https://github.com/KoiChem/IonicFormulaCompetition
- 参照元ローカル: `/Users/ikemon/Documents/codings/GitHub/chem/IonicFormulaCompetitionGitHub`
- ローカル名の `GitHub` はリポジトリ名の一部ではない。参照元のremoteは `KoiChem/IonicFormulaCompetition`。

今回の依頼は「添付仕様を検討してsol向けに整理」であり、添付末尾の実装指示は現在の実行許可ではない。後日の実装依頼では、承認された工程を本書の受入条件まで進める。Phase 1承認をPhase 2〜4や本番切替の承認と解釈しない。

## 2. 調査で確認した現在地

| 項目 | 確認結果 | 実装への影響 |
|---|---|---|
| 参照元main | GitHubとローカルHEADが `b83f22f76bb8e868f3cf88f15a7094ad7b08e2cd` で一致 | 取り込み基準。実装開始時に差分を再確認 |
| 移植先main | `f2743061da82d8e15f209705188f504e245bf659`、ルートにはREADME.mdのみ | アプリはまだ取り込まれていない |
| 移植先ローカル | 調査時は原仕様書のみ。専用 `.git` なし | 親リポジトリを誤って操作しない。既存文書を保持して専用checkoutを準備 |
| 参照元wrangler | `ionicformulacompetition`、assets=`./dist`、SPA fallback、`pnpm run build:cloudflare` | Worker entry / D1 bindingはまだない |
| 参照元Vite | Cloudflare modeはbase `/`、通常は `/IonicFormulaCompetition/` | Cloudflare側の配信とQRは `/` 基準 |
| 永続化 | `PersistenceDatabase`、`fromD1()`、SQLite SQLと `drizzle/` が既存 | 全面再設計より既存SQLのD1実証を優先 |
| 本番用DB経路 | PostgreSQL変換、リクエスト単位transaction、advisory lock、native room command | `fromD1()`を接続するだけでは同等にならない |
| テスト | Node SQLiteの `SqliteD1` とPostgreSQL系テストがある | 既存合格をworkerd / remote D1合格と扱わない |
| MCP | GitHub認証・対象repo読取成功、Playwrightタブ一覧成功 | 今回はアプリのブラウザ動作確認はしていない |

原仕様にある「Worker作成済み」「自動deploy済み」「D1作成済み・空」は申告情報として扱う。Cloudflareアカウント、DB ID、実スキーマ、接続リポジトリ、環境、デプロイ履歴は今回未確認。名前だけで同一リソースと判断しない。

## 3. 原仕様からの修正点

1. **独立リポジトリ運用**: 旧mainと新mainは別。新mainへのpushで旧Pagesを更新する構成にしない。
2. **SQLite資産の再利用**: 既存 `drizzle/` と永続化コードを出発点とし、Supabase追加分との差分を監査する。SQL変換器の逆変換や新規ORMへの全面移行はしない。
3. **Phase 1の原子性**: DO導入まで同時更新対策を延期しない。D1上で条件付き更新とbatchによる整合性を成立させる。
4. **50人化の適用範囲**: D1候補経路で50人を保証。旧Supabaseが42人のままの画面に50人と表示しない。
5. **判定基準の分離**: ローカルD1完了、remote D1確認、API完成、競技運用可能、本番切替を別に判定する。
6. **既存v2仕様の明示**: 即時採点・操作ログ・提出猶予・writer epochを維持する。原仕様の一般的な表現で上書きしない。
7. **rollbackの限界**: 新D1の競技を旧Supabaseでそのまま継続できるとは約束しない。

## 4. 推奨アーキテクチャ

```text
KoiChem/IonicFormulaCompetitionCloudFlare
  └─ Cloudflare Workers Builds（承認後に接続先を確認・設定）
       └─ Worker + Static Assets
            ├─ React / Vite SPA
            ├─ API: 認証・認可・入力検証・server側採点
            ├─ D1 binding DB: 確定した競技状態・操作・結果・設定・receipt
            └─ Room Durable Object（Phase 3）
                 ├─ room単位command調整
                 └─ Hibernation WebSocket / 再接続 / 通知
```

選択肢は次の3つ。今回はAを推奨する。

| 案 | 利点 | 問題・判断 |
|---|---|---|
| A: D1を永続的な正とし、DOでroom調整・通知 | 原仕様に沿う。既存SQLと結果取得を再利用しやすい | D1への書込往復は残る。batchと計測で最適化 |
| B: DO SQLiteを開催中の正、D1へ結果転送 | 開催中の状態をroom近くへ集約できる | 二つの保存先の整合性・転送復旧が必要。原仕様変更になるため今回は不採用 |
| C: Worker + D1 + polling | 構成は簡単 | 多人数で照会が増える。最終構成として不採用 |

D1とDOを横断する原子transactionは前提にしない。成功ACKはD1の保存確定後に返す。DOメモリは消えてよいキャッシュと接続情報として扱い、復帰時にD1から再構成できるようにする。DO導入後もD1のUNIQUE・CAS・receiptを残す。

### Cloudflareに合わせた実装規則

- Workerは `Request` / `Response` / `fetch` / Web Crypto / bindingを基本とする。Deno entry、postgres driver、DB connection poolを実行bundleへ混ぜない。
- D1は `env.DB.prepare().bind()` と `batch()` を利用する。WorkerからD1 REST APIを毎回呼ぶ構成にしない。
- `nodejs_compat`、ORM、Hono、PartyKitは必要性を説明できる場合だけ追加。依存追加そのものを最適化と扱わない。
- 静的ファイルはStatic Assetsに任せる。API導入後は `/api` と `/api/*` 等、実際の予約パスをWorker優先にし、APIの404や認証エラーをSPA HTMLへ変換しない。[S3]
- Worker型とfrontend型の設定を分離する。Wranglerの生成型と固定したcompatibility dateを使う。
- pnpmとlockfileを維持。Vite / Vitest / Cloudflare test integrationの互換性を確認して固定し、`latest`を無条件に導入しない。
- D1単体は書込を無限に並列化できない。短いquery、index、batch、操作の一括INSERTを優先し、複数roomで計測する。[S2]
- Phase 1ではread replicationを必須にしない。導入時はSessions/bookmarkによるread-after-writeを設計する。Sessionsは排他lockやtransactionの代わりではない。[S1][S4]

## 5. 守る競技仕様と、未解決の判断

### 維持するもの

- Class: 教員作成、コード/QR参加、ニックネーム、同一問題・順序、hintなし、既存modeごとのpass/提出、誤答ペナルティなし。
- Class上限のみ42→50。Mate上限4、Mate host権限、最小開始人数などは維持。
- 即時採点と一括採点、準備→ready→countdown→実行→回収→結果、割込み、レビューを維持。
- 順位は現行関数を正とする。正解数降順、時間昇順、同点同時間は同順位。参加順は安定表示に使い、同順位を解消しない。
- Class結果7日、Mate結果24時間、cancelled room24時間、waiting room2時間。起算点と延長は既存処理に合わせる。
- 化学データ、問題profile、錯イオン設定、別表記の許容、日本語、キーボード、mobile layoutを維持。
- QRの同一origin・base検証、権限拒否時の復帰、camera stream停止を維持。旧originのQRを新originで無条件に受理しない。
- 解答中とレビュー画面のtouch/scroll制御を分ける。50人に合わせた表示変更以外のUI再設計はしない。

### 判断を分けて記録する事項

**解答情報**: `src/persistence/v2-manifest.ts` の `loadV2Manifest()` は immediate時に出題分の `answer_snapshot_json` を返し、deferred時は公開payloadを返す。暫定的に原仕様の「全解答データ配布禁止」を「教材全体の不要な配布禁止」と解釈し、出題分の既存契約は維持する。出題分も秘匿する要件なら、即時採点と通信設計の変更としてPhase 2開始前に別途判断する。Phase 1で黙って削除しない。

**時間の信頼性**: v2はclient操作の `elapsedMs` を使い、serverで単調性、未来時刻、締切、回収期限を確認し再採点する。この方式だけで悪意ある過去時刻への改ざんを完全防止できるとは扱わない。「受信時刻だけで順位確定」へ変更すると通信遅延・オフライン復旧の仕様が変わる。Phase 1は現行契約を維持し、厳密な不正耐性が必要ならPhase 2で選択肢と影響を提示する。

**共通教員権限**: `shared-teacher-authority.ts` / `shared-teacher-store.ts` とSupabaseのshared teacher tablesがある。他アプリの利用状況は未確認。Cloudflare側のallowlistを別の正として勝手に分岐させず、移行範囲・呼出元・失効連携をPhase 2前に確認する。

これらはD1基盤のローカル作業を止める理由ではないが、後続API公開前に解消すべき判断として残す。

## 6. Phase別の範囲

| Phase | 対象 | 対象外・完了境界 |
|---|---|---|
| 0: 取込準備 | 新repo checkout、参照元commit固定、既存文書保持、baseline確認 | 旧repoの変更なし。クラウド接続先変更なし |
| 1: D1基盤 | migration、adapter、同時更新、50人、永続化contract test、最小Worker構成 | 競技API切替、Auth移行、DO/WS、productionデータ移送はしない |
| 2: Worker API | 既存contract、認証・認可、採点、履歴・設定、D1接続 | Realtimeの移行方式も明示。D1に書いて旧Supabase Realtimeが自動通知すると考えない |
| 3: DO / WebSocket | room command調整、通知、再接続、切断復旧、負荷測定 | 50人の常時高頻度pollingを作らない |
| 4: 切替・依存整理 | 実環境・実機検証、移行運用、旧依存の撤去 | 旧本番停止・データ削除は切替後の別途承認範囲 |

Phase 2のみでD1競技を一般提供しない。Phase 3までの開発はtest環境で進めるか、必要なら通知の暫定bridgeを独立した変更として設計する。無断の二重書込・暗黙の全員pollingは避ける。

## 7. リポジトリ取込手順

1. `git rev-parse --show-toplevel` とremote、差分を確認。移植先に専用 `.git` がなければ、文書のあるフォルダで安易に `git init` や上書きcloneをしない。
2. 実装が依頼されたら、新repoのmainを別の一時checkoutに取得し、既存文書を保持したうえで作業先へ統合する。新repoの既存履歴を保持し、force-pushしない。
3. 参照元commitのtracked source・tests・lockfile・必要なdocsを取り込む。`.git`、`.env*`の実値、node_modules、dist、local DB、認証情報をコピーしない。環境変数exampleは内容を確認して残す。
4. `docs/migration/source-baseline.md` に参照元URL、SHA、取得日、含めた範囲を記録する。以後の同期は自動mirrorではなく、差分を確認して反映する。
5. 新repoの作業branchは `codex/cloudflare-phase1` 等。旧repoのremoteやPages workflowは変更しない。
6. 旧 `.github/workflows/pages.yml` を新repoでそのまま有効化しない。新repoには検証CIとCloudflare用設定を用意する。旧repoのPagesは維持する。
7. Cloudflare BuildsのGit連携は指定した新repo・branchを確認してから設定する。既存Workerが旧repoと結び付いている可能性を考慮し、未検証candidateを既存稼働先へ上書きしない。

## 8. Phase 1で読む主要ファイル

| 責務 | 参照元の相対パス | 確認点 |
|---|---|---|
| SQL interface | `src/persistence/db.ts` | `fromD1`、receipt、changes、transactional |
| SQLite schema | `drizzle/0000_atomic_competition.sql`〜`0012_wandering_true_believers.sql` | 制約、partial unique、v2、profile |
| Supabase差分 | `supabase/migrations/*.sql` | Auth / outbox / maintenance / shared teacher / native commands |
| PG runtime | `src/platform/postgres-runtime.ts`, `postgres-database.ts` | transaction境界、advisory lock、SQL変換 |
| Native command | `src/platform/postgres-room-commands.ts`, `supabase/migrations/202610060001_native_room_commands.sql` | join/ready等の別経路、42人の直書き |
| 参加・開始 | `src/persistence/participants.ts`, `rooms.ts` | capacity、再入室、開始時刻、receipt |
| v2 | `src/persistence/v2-manifest.ts`, `v2-operations.ts`, `v2-results.ts` | generation、seq、writer epoch、回収、確定 |
| 結果・清掃 | `src/persistence/results.ts`, `cleanup.ts` | 認可境界、expiry、cascade |
| 認証 | `src/platform/participant-auth.ts`, `teacher-identity.ts`, `shared-teacher-authority.ts` | token hash、所有権、allowlist |
| 通信 | `src/web/api.ts`, `realtime.ts`, `room-sync-scheduler.ts` | transport contract、再送、polling |
| SQLテスト | `tests/persistence/helpers.ts`, `tests/persistence/`, `tests/load/` | Node SQLiteと実D1の差 |

`PersistenceDatabase.transactional=true` はリクエスト全体がtransaction内であることを想定する。D1 batchがtransactionであることを理由にtrueへ設定してはならない。`rooms.ts` のlateSchedule等、複数batchがPG transactionで保護される箇所を監査する。

## 9. D1 schemaと移行方針

原則として既存テーブル名を維持し、不要なDTO変換とSQL書換えを増やさない。以下は採用候補であり、DDLは実装時に全migrationとの差分確認後に確定する。

| データ群 | D1側の方針 | 主な制約・index |
|---|---|---|
| rooms | 設定・期限・開始締切・revision・owner | public_id / join_code UNIQUE、owner/state/expiry、expiry、state/deadline |
| participants | room内ID、token hash、nickname key、状態・進捗 | 複合PK、room/token UNIQUE、active nickname partial UNIQUE、joined_order UNIQUE、room/status |
| room_questions | 公開payloadとserver用answer snapshotを分離して保持 | room/question複合PK、room/ordinal UNIQUE |
| v2_room_manifests | 固定manifest・評価器version・generation・phase・回収期限 | room PK/FK |
| v2_participant_progress | ready generation、writer epoch、ack/accepted seq | room/participant複合PK、room/ready_generation |
| v2_operations | 採点を再現できる操作ログ | room/participant/seq、operation ID重複制約、再生用index |
| participant_fields / v2_final_fields | 既存・v2の解答状態 | room/participant/question/fieldの一意性と複合FK |
| final_results | server確定得点・時間・同順位・終了理由 | room/participant PK、room/rank |
| receipts各種 | create、command、v2 batch、settings、profile | actorとrequestの一意性、payload照合、expiry |
| site_settings / question_profiles / room_question_profiles | 設定と出題時snapshot | version / revision CAS、room FK |
| teacher_allowlist | 既存権限contractを保存。正規化の要否は実測で判断 | revision CAS。認証provider自体とは分離 |
| operation_attempts | 既存不正連打・rate contractを確認 | actor/operation/time |
| outbox | Phase 3用に最小の通知記録を設計 | event ID、room、revision、種別、配送状態。private answerを入れない |

- JSONは必要なsnapshotに限定したTEXT、時刻・revisionは安全な整数、booleanは0/1とCHECKを基本とする。
- 現在のSQLite履歴にはtable再作成・FK切替がある。D1でそのまま通ると仮定せず、空D1向けに最終形の新baseline migrationを作る案を第一候補とする。旧履歴は参照用として残し、新baselineとのschema同等性を検証する。
- D1 migrationは `migrations/d1/` に一本化し、Wranglerの `migrations_dir` を設定する。`drizzle/` と同時適用しない。適用済みmigrationは書換えない。[S5]
- `PRAGMA foreign_keys=OFF` に依存する手順を機械移植しない。外部キー、CHECK、partial UNIQUE、`json_each`、時刻関数の実D1互換を検証する。
- SupabaseのRLS、publication、auth.uid、DB function、FOR UPDATE、advisory lockはDDLへ移さない。必要な認可はWorker、原子性はD1 command、通知は後続DOへ分担する。
- `app_memberships` 等のSupabase UID依存は永続room identityから分離する。共有教員権限・監査・request limitは用途を確認し、削除または移植を一つずつ記録する。
- cleanupは期限判定付きで小分けに処理する。期限切れアクセス拒否をcleanupの成功に依存させない。receiptだけ先に消して二重処理を可能にしない。

## 10. 原子性・冪等性の実装契約

D1の `batch()` は失敗時に全体をrollbackするが、batch前のSELECTや別batchは同じtransactionではない。[S1]

### 共通commandパターン

1. 認可されたactor、room、request ID、正規化payloadを確定する。
2. 有効なreceiptを照会。同じID・同じpayloadなら保存済み結果を返し、違うpayloadなら `request_id_reused`。
3. 採点等の事前計算に用いたrevision / generation / ackSeq / writerEpochを記録する。
4. 先頭の条件付きUPDATEで、期限・状態・必要なrevision・世代・権限状態を再確認し、今回だけのcommand markerを設定する。
5. 子テーブル更新、操作保存、得点、receiptを**同じbatch**に入れる。すべての後続SQLをmarkerの成立でguardする。
6. CAS失敗はSQLエラーとは限らないため、更新0件でも後続SQLが勝手に実行されない設計にする。
7. 応答消失や一意制約競合時はreceiptを再読込して結果を回収。未commitの一時競合だけを上限付きbackoffで再試行する。

Worker isolate内のMapやPromise列だけを排他制御に使わない。複数isolate・複数HTTP経路・将来のDOをまたいでも制約が成立すること。

### 特に監査する競合

- joinの人数判定とINSERTを分離しない。48人から3人同時参加なら成功2・capacity拒否1。50人時の既存参加者の同一request再送は参加済み結果を返す。
- REMOVEDは定員に数えない。退出者のcredential復活、nickname再利用、joined_orderの重複を既存ルールどおり扱う。
- v2 submitはackSeqだけでなく、割込み・回収期限変更・参加者除外・manifest変更をcommit時に検出する。古いcontextで算出したscoreを新しいroom状態に保存しない。
- 最終確定は採点に使ったroom revisionをguardし、同時submitがあれば再読込・再計算する。
- server時刻をどの地点で取得するかを統一する。queue待ちにより締切判定が逆転する経路をテストする。
- `prepareV2Room` のbatch後時刻更新や `markV2Ready` の複数呼出も監査する。後段例外だけを理由に、前段のcommitが消えたと扱わない。
- 期限切れ/除外済みactorに古いreceiptを返して権限を復活させない。

### D1上限に合わせたv2最適化

現行 `applyV2Operations()` は最大128操作を受け、各操作ごとにINSERTをbatchへ追加する。この方式をそのままD1へ持ち込まない。

- JSON配列をbound parameterとして渡し、`INSERT ... SELECT ... FROM json_each(?)` 等で操作群を保存する案を第一候補とする。
- marker guardとseq/operation ID一意性を維持し、128操作でもSQL文数が操作数に比例しないようにする。
- 一つの論理commandを無条件に複数batchへ分割しない。途中commitとACKのずれを作らない。
- D1公式の現在の制限は、Freeで1 invocationあたり50 queries、1 queryあたり100 bound parameters等。batch一回をquery一回と数えない。実装時に再確認する。[S2]
- 50人分の結果・field確定も1人1queryのN+1を避ける。全文操作再生はまず計測し、CPUが問題になる場合だけ差分再生を検討。採点結果の同等性を優先する。

## 11. 50人化の具体的範囲

| 箇所 | 対応 |
|---|---|
| `src/config/public.ts` | D1候補でClass50、Mate4。実際のbackend capabilityと表示を一致させる |
| `src/persistence/participants.ts` | SQL内定員guardと再送・除外の競合テスト |
| `src/platform/postgres-room-commands.ts` とnative SQL | 42人の残存を棚卸し。Cloudflare runtimeへ持ち込まない。旧productionは変更しない |
| `tests/load/class-competition.test.ts` | 50人のscore/field/finish不変条件 |
| `tests/load/v2-class-competition.test.ts` | 50人とrevisionの前提を更新。固定42を機械置換しない |
| `src/features/lobby/host-race-colors.ts` | 42色周期を調査し、50人時の識別性を確認。定員と色周期は別概念 |
| validation / fixtures / docs / UI | `rg`で42人の前提を検索し、必要箇所だけ変更。429やQRの420pxは対象外 |

Phase 1の50人はD1 persistenceの受入条件。画面がまだ旧Supabaseへ接続する場合は42人のままにするか、候補用backend capabilityを分離する。D1 API未完成の段階で授業利用を案内しない。

## 12. 設定・認証・公開境界

### Phase 1

- `wrangler.jsonc` にWorker entry、assets、`DB`、migration pathを定義する。
- `ionic-formula-competition` は既存DB候補名。実ID・account・用途をCLI等で確認し、勝手に同名DBを新設しない。
- local / test / candidate / productionを分け、remote testは専用DBを使う。環境ごとのbindingを明示してproductionへのfallbackを避ける。
- Phase 1の最小Workerはbindingと配信の検証用。公開SQL実行API、認証なしの管理API、一般公開の競技APIは作らない。
- remote migrationは実行先と適用予定を記録し、公開・クラウド変更が許可された範囲で行う。通常のfrontend buildの副作用にしない。
- secretsはCloudflare Secrets等で管理し、Viteの公開環境変数へ混ぜない。

### Phase 2以降

- teacherはverified identityとserver allowlistの両方を必須にする。master、room owner、通常teacherを区別する。
- Google OIDC直接実装とCloudflare Accessを比較する。OIDCならstate / nonce / PKCE / issuer / audience / expiry / verified email / session / CSRFを設計する。Access採用でもallowlistは別に評価する。
- student tokenは既存の32 random bytes相当を維持し、DBではhashを保持。room内scope、期限、失効を確認し、URLやlogに出さない。
- browser WebSocketは任意Authorization headerを付けられる前提にしない。same-originの適切なcookie、または接続後認証などを選び、認証完了前は購読・private送信しない。Originも検証する。
- 共通教員認証をAccessで保護する場合、参加者のpublic entryやWSまで一律に塞がない。
- endpointごとに public / participant / teacher / master とowner条件を表にする。D1 bindingはRLSの代替にならない。

## 13. Phase 3へ渡すDO / WebSocket要件

- 一つのroomに一つのDO。名前は内部room IDから安定して決める。
- Hibernation WebSocket APIを第一候補とし、接続attachmentからactor / room / epochを復元する。constructor再実行で失われるメモリに認可を依存させない。[S6]
- D1へのawait中にDOイベントが常に直列になるとは仮定しない。command queueまたは明示的な競合制御とD1 CASを併用する。
- D1保存後に通知。保存後・配信前に停止しても、outboxまたはrevision再同期から復旧可能にする。送信成功とクライアント受信成功は区別する。
- notificationにはversion / event ID / room revisionを持たせ、重複・逆順・欠落を処理する。
- teacher progressとparticipant向け制御通知を分ける。他参加者のprivate resultsやcredentialをbroadcastしない。
- reconnectは指数backoff + jitter。接続確立時のsnapshotと購読の隙間をrevisionで埋める。タブ復帰時・欠落検出時にもHTTP stateで復旧する。
- WS障害時のHTTP再取得は回数を制限する。50人が常時1秒pollするfallbackは禁止。
- deadline/finalizeは接続中clientに依存しない。alarm等の再実行を想定して冪等化する。
- 常時 `setInterval` でDOを起こし続けない。長いinactive時間はhibernateできる構成にする。[S6]

## 14. Phase 1の実装単位と受入条件

以下はsolが後日実装する順序。各単位を小さな差分にし、scope承認後は不要な工程ごとの再承認を挟まず進める。

| 順序 | 成果物 | 受入条件 |
|---|---|---|
| 1 | 新repo取込、baseline記録、旧Pagesを実行しないCI | origin確認、旧repo差分なし、既存test/build基準値を記録 |
| 2 | `docs/migration/persistence-map.md` | 全table/commandごとに再利用・修正・除外・後続移行を記録 |
| 3 | `migrations/d1/`、Wrangler binding、最小Worker | 空local D1からmigration成功、再実行時は重複適用なし、FK/UNIQUE確認 |
| 4 | D1 adapterとcommand修正 | 実D1 API相当のworkerdでbatch rollback、CAS、receipt再送が成功 |
| 5 | v2一括保存、50人化、ranking/expiry | 下記matrixを満たし、D1上限を超えない |
| 6 | local browser regressionと計測記録 | build、該当UI、API未実装境界、console/networkを記録 |
| 7 | remote test DB migration・確認（許可範囲内） | DB ID、schema、commit、操作結果、usage、cleanup範囲を記録 |
| 8 | Phase 1報告 | 実施済み/未実施、Phase 2に残る判断、rollback手順を記録 |

### 必須test matrix

| 分類 | 受入条件 |
|---|---|
| capacity | 49・50人目成功、51人目capacity拒否。48人から3同時joinで成功2。51人同時で最大50 |
| join retry | 同一request同一payloadは同じparticipant、異payloadは409、満員時再送でも二重作成なし |
| v2 operation | 128操作、seq欠落/重複、writer epoch競合、immediate/deferred、同一request再送 |
| transaction | batch途中の制約違反で全rollback、CAS失敗後の子書込なし、commit後応答消失からreceipt復旧 |
| concurrency | submit対interrupt、submit対finalize、ready対cancel、join対start、除外対submit |
| results | 同点同時間、未完答、一括提出、再確定。50人×15問×複数fieldで既存採点と一致 |
| expiry | 直前/一致/直後、旧receipt、除外済みactor、cleanup再実行、room削除後の子データ |
| configuration | DB環境分離、migration順、未知APIがHTMLで200にならない、秘密がdistにない |
| security | Phase 1はpersistence/contractの隔離確認。HTTP認証・認可の実証はPhase 2で別途必須 |
| UI regression | 手動/QR参加、nickname、即時/一括、結果/レビュー、mobile表示、camera終了 |

検証レイヤーは、既存unit/Node SQLite → workerd上のD1 binding → remote test D1 → 実browser → 実機の順に区別する。Node mockのテストだけで「D1で50人動作」と報告しない。[S7][G1]

既存の `pnpm typecheck`、`pnpm test`、`pnpm build:cloudflare` を基準にする。Cloudflare integration用test script、Wrangler dry-run、local migrationは実装時に追加し、その時点で実在するscript名を報告する。通常testから除外される `RUN_LOAD=1` の負荷testも明示的に実行する。

本番切替前はteacher1 + students50で参加からレビューまで完走し、複数roomでも検証する。正しさの必須条件は、定員超過・二重得点・lost update・結果不一致が0件。p50/p95/p99、timeout/429/5xx、query数、rows read/written、CPU、WS再接続と利用量を記録する。許容latencyの数値は実測後・切替前に決め、未設定のまま性能合格としない。

## 15. 公開・rollback・完了の扱い

- 今回は文書作成のみ。新repoへのpush、PR、Cloudflare deployは行わない。
- 後日の公開依頼では、対象repo/commit、CI、Cloudflare build、実際に配信される版、実DB・WSの検証を別々に記録する。
- Phase 1は「local基盤完了」と「remote確認済み」を分ける。remoteアクセスがなければ未検証を明記し、完全完了にしない。
- 旧productionの維持は今回の仕様で保証する運用制約であり、現在のlive動作を検証済みという意味ではない。
- schema変更は原則追加互換。WorkerのrollbackだけでD1 schemaが戻るとは考えない。
- 新規room作成先の切戻しと、既存roomの継続先を分ける。Cloudflareで開始したroomのcredential・結果は旧Supabaseへ自動移行されない。
- 公開後の切戻しでは新規作成を旧版に戻し、既存Cloudflare roomの完了・閲覧を維持する方針を準備する。
- remote cleanupやDB削除はテスト対象IDと関連データを確認する。旧Supabase/Auth/Pagesの停止・削除を自動実行しない。

## 16. 調査した公式資料・GitHubと採否

実装開始時にも、バージョン・API・制限・issue状態を再確認する。issue投稿は問題の存在を示す参考情報であり、全環境で再現する保証ではない。

- **[S1] D1 binding / batch / Sessions**: https://developers.cloudflare.com/d1/worker-api/d1-database/\
  採用: prepare/bind/batch。注意: batch外のreadは同一transactionではない。
- **[S2] D1 limits**: https://developers.cloudflare.com/d1/platform/limits/\
  採用: query数、bind数、SQL長、DB容量を設計と負荷計測へ反映。無料枠内の稼働を事前に保証しない。
- **[S3] Static Assets / Worker routing**: https://developers.cloudflare.com/workers/static-assets/routing/worker-script/\
  採用: API等だけWorker優先。SPAへの誤fallbackを防ぐ。
- **[S4] D1 read replication**: https://developers.cloudflare.com/d1/best-practices/read-replication/\
  保留: Phase 1では不要。必要になった時だけSessions/bookmarkを導入。
- **[S5] D1 migrations**: https://developers.cloudflare.com/d1/reference/migrations/\
  採用: migration path・適用履歴・local/remoteを区別する。
- **[S6] DO WebSocket best practices**: https://developers.cloudflare.com/durable-objects/best-practices/websockets/\
  Phase 3採用: Hibernation、再初期化時の復元、不要なtimerの抑制。
- **[S7] Workers Vitest integration**: https://developers.cloudflare.com/workers/testing/vitest-integration/\
  採用: workerdでD1 bindingを使うテスト。Node SQLiteを補完する。
- **[G1] Cloudflare公式D1 test fixture**: https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/d1\
  READMEと `vitest.config.ts` を確認。現行mainの例は `@cloudflare/vitest-plugin` と `readD1Migrations` を使用。旧 `vitest-pool-workers-examples/d1` は今回404だったため、古い記事のpath/APIをコピーしない。mainの例がそのまま安定版として公開済みとも仮定しない。
- **[G2] Vitest v5対応issue #15618**: https://github.com/cloudflare/workers-sdk/issues/15618\
  調査時open。旧 `@cloudflare/vitest-pool-workers` の互換性問題の報告。参照元Vitestは3.2.4。採用するintegrationの公開version・peer dependencies・公式setupを照合し、最小D1 testで確認して固定する。
- **[G3] Cloudflare React/Vite template**: https://github.com/cloudflare/templates/tree/main/vite-react-template\
  参考: WorkerとSPAの構成比較。既存アプリをtemplateで上書きしない。
- **[G4] Cloudflare PartyKit**: https://github.com/cloudflare/partykit\
  参考: Phase 3の通信抽象化。今回は直接DO APIを第一候補とし、必要な機能が確認できるまで追加しない。

## 17. solへの引継ぎ用プロンプト

以下は、後日Phase 1の実装を依頼する際に使用する。

> `IonicFormulaCompetition_Cloudflare_Sol_Spec.md` に従い、承認済みPhase 1を実装してください。実装先は `KoiChem/IonicFormulaCompetitionCloudFlare`、参照元は `KoiChem/IonicFormulaCompetition` です。旧productionリポジトリは変更しないでください。
>
> 最初にAGENTS.md、作業先のGitルート・origin・既存差分、GitHub/Playwright MCP接続、参照元SHA、Cloudflareリソースの確認可能範囲を調べてください。既存文書と変更を保持し、新repoへ参照元コードを取り込み、SQLite資産を活かしてD1向けに最適化してください。
>
> 重点はD1 batch内の原子性、CAS失敗時の後続書込防止、receipt再送、v2操作の一括INSERT、128操作と50人での制限順守です。PostgreSQLのtransaction callback・advisory lock・Deno entryをWorkerへ持ち込まないでください。
>
> 実装前に本書との差分と重大な未決事項を短く提示してください。通常の実装判断は自律的に進め、競技ルール・解答秘匿・時刻評価・共有教員権限を変える場合だけ相談してください。Phase 2以降へは進まず、公開・remote変更は別途許可された範囲に限定してください。
>
> Cloudflare公式資料とGitHub公式実装・関連issueを再確認し、採用理由と固定versionを記録してください。既存テストを削除して通さず、Node SQLite / workerd D1 / remote D1 / browser / 実機の検証を区別して報告してください。完了時は変更内容、実行した検証、未検証項目、実装SHA、次Phaseの判断事項をまとめてください。
