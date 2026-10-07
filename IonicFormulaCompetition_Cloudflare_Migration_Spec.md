# IonicFormulaCompetition
# Cloudflare 本格移植仕様書

## 0. プロジェクト概要

Repository:

`KoiChem/IonicFormulaCompetition`

対象ブランチ:

`main`

目的:

現在の

- GitHub Pages
- Supabase Auth
- Supabase PostgreSQL
- Supabase Edge Functions
- Supabase Realtime

で構成されている IonicFormulaCompetition を、段階的に

- GitHub
- Cloudflare Workers
- Cloudflare D1
- Cloudflare Durable Objects
- WebSocket

を中心としたCloudflareネイティブ構成へ移植する。

単なるホスティング先変更ではなく、

- 応答速度
- 同時利用安定性
- リアルタイム通信効率
- 無料枠利用効率
- 保守性
- 将来のCompetition系アプリへの再利用性

を改善することを目的とする。

既存UI・教材ロジック・競技ルールを作り直すプロジェクトではない。

---

## 1. 最終目標

最終的な基本構成は以下とする。

```text
GitHub
   │
   │ push
   ▼
Cloudflare Workers
   │
   ├─ Static Assets
   │    React / Vite SPA
   │
   ├─ Worker API
   │
   ├─ D1
   │    永続データ
   │
   └─ Durable Objects
        開催中Room
        WebSocket
        Realtime coordination
```

D1を永続データのsource of truthとする。

Durable Objectsは開催中Competitionのリアルタイム状態・接続・同時更新制御を担当する。

Durable Objectだけに重要な永続データを保持しない。

---

## 2. 現在のCloudflare準備状況

Cloudflare側では以下まで完了済み。

Worker:

`ionicformulacompetition`

GitHub mainとの自動Deploy:

設定済み

Vite build → Cloudflare Workers:

Deploy成功済み

Cloudflare Static Assets:

`./dist`

SPA fallback:

`single-page-application`

wrangler設定:

`wrangler.jsonc`

D1 Database:

`ionic-formula-competition`

現時点ではD1は空。

Workerからのbinding名は以下を使用する。

```text
DB
```

今後Cloudflare設定は可能な限り `wrangler.jsonc` をsource of truthとしてGit管理する。

Dashboard上だけに存在する設定を増やさない。

SecretsのみCloudflare Secrets等で管理する。

---

## 3. 最重要仕様変更

### Class Competition 最大参加人数

現行:

```text
42人
```

変更後:

```text
50人
```

Class Competitionの正式な最大参加人数を50人とする。

以下を必ずテストする。

```text
49人目 → 成功
50人目 → 成功
51人目 → 明示的に拒否
```

単にUI上の表示だけを変更してはならない。

以下を含め、42人前提をリポジトリ全体から調査する。

- validation
- API
- persistence
- Realtime
- load tests
- fixtures
- constants
- documentation
- comments
- capacity calculation

Mate Match等、Class Competition以外の人数制限は既存仕様を維持する。

---

## 4. 移植中の最重要原則

Cloudflare版の完成までは、

```text
GitHub Pages + Supabase版
```

を現行productionとして維持する。

Cloudflare移植によって既存版を壊さない。

移植期間中は以下を並行して存在させる。

```text
既存production

GitHub Pages
    ↓
Supabase
```

```text
新Cloudflare candidate

Cloudflare Workers
    ↓
D1 / Durable Objects
```

Cloudflare版が本番移行条件を満たすまでは、

- Supabase DBを削除しない
- Supabase Edge Functionsを削除しない
- Supabase Realtimeを削除しない
- Supabase Authを削除しない
- GitHub Pages workflowを削除しない
- 既存Supabase設定を破壊しない

こと。

GitHub Pages版はCloudflare移植期間中のproductionおよびrollback先として扱う。

---

## 5. 段階移植方針

本移植は一括置換しない。

以下の4 Phaseで進める。

```text
Phase 1
D1移植
    ↓
Phase 2
API互換化
    ↓
Phase 3
RealtimeをDurable Objects化
    ↓
Phase 4
Supabase撤去
```

各Phaseを独立して検証する。

一つのPhaseで問題が発生した場合に、どの層が原因か追跡できる構造を維持する。

---

## 6. Phase 1 — D1移植

### 今回の実装対象

今回実施するのはPhase 1のみ。

Phase 2〜4の実装には進まない。

ただし、後続Phaseを阻害しないinterface境界を設計する。

### Phase 1の目的

現在Supabase PostgreSQLが担っている

- schema
- persistence
- transaction semantics
- competition state storage
- participants
- submissions
- results
- settings
- expiry
- idempotency

等を調査し、

Cloudflare D1 / SQLite向けの永続化基盤を作る。

この段階では、Supabase productionを停止しない。

### 6.1 現状調査

まずコード変更を行わず、以下を完全に調査する。

- Supabase PostgreSQL schema
- migrations
- persistence adapter
- Edge Functionとの境界
- transaction処理
- PostgreSQL advisory lock
- SERIALIZABLE / READ COMMITTED依存
- RPC
- RLS
- Supabase Auth依存
- Realtime用outbox / event
- idempotency receipt
- ranking
- expiry / cleanup
- teacher settings
- competition manifest
- participant ownership
- answer/submission storage

その上で、

```text
Supabase/PostgreSQL
        ↓
Cloudflare D1
```

の対応表を作成する。

### 6.2 D1 Binding

既存D1:

```text
ionic-formula-competition
```

をWorkerへ

```text
DB
```

というbinding名で接続する。

`wrangler.jsonc` に設定を記述し、Git管理する。

Dashboard上だけのbinding設定で完結させない。

### 6.3 D1 Schema

PostgreSQL schemaを機械的にSQLiteへ変換しない。

D1 / SQLiteに適したschemaへ再設計する。

想定される主なentity:

- competitions
- participants
- competition_questions / manifest
- submissions
- participant_progress
- results
- ranking data
- teacher accounts / allowlist
- global settings
- competition settings
- idempotency receipts
- realtime/outbox用データ
- expiry metadata

実際のtable分割は現行コード調査後に決定する。

### 6.4 PostgreSQL固有機能の排除

以下をD1へそのまま持ち込まない。

- advisory locks
- PostgreSQL-specific JSON操作
- PostgreSQL function
- PostgreSQL RPC
- RLS
- PostgreSQL固有transaction構文
- Supabase publication
- Supabase Auth table依存

それぞれについてCloudflare/D1での代替方法を設計する。

Phase 1ではRealtime coordinationを無理にD1へ押し込まない。

将来Durable Objectsへ移す責務は明確に分離しておく。

### 6.5 Persistence abstraction

frontendやdomain logicが直接

```text
Supabase
```

または

```text
D1
```

を意識しすぎない構造とする。

可能であれば、

```text
Competition domain
        ↓
Persistence interface
        ↓
 ┌─────────────┐
 │ Supabase    │
 │ D1          │
 └─────────────┘
```

のような境界を作る。

ただし過度なframework化は行わない。

Phase 1の目的はD1 persistenceを成立させることであり、Competition frameworkそのものを新規開発することではない。

### 6.6 Migration

D1 migrationをGit管理する。

以下を可能にする。

```text
local D1
remote D1
```

へのmigration適用。

migrationは再現可能であること。

production D1をDashboardから手作業で編集する運用を前提としない。

### 6.7 Index

以下の検索パターンを確認し、必要なindexを作成する。

例:

- room / competition lookup
- participant lookup
- competition + participant
- submission lookup
- result lookup
- expiry
- teacher allowlist
- competition status

50人程度のcompetitionであっても、不要なfull-table scanを繰り返さない。

### 6.8 既存本番データ

Phase 1では既存Supabase productionデータをD1へ強制的に一括移行しない。

まずschema / persistence / testを完成させる。

本番既存データをCloudflareへ移す必要がある場合は、安全なmigration scriptを別途設計する。

実データ移送をPhase 1成功条件にはしない。

---

## 7. Phase 1 完了条件

Phase 1は以下を満たした時点で完了とする。

- D1 binding `DB` が成立
- `wrangler.jsonc` に設定が存在
- D1 schemaがmigration管理される
- local D1でintegration test可能
- remote D1へmigration可能
- D1 persistence adapterが存在
- 50人capacity仕様が反映
- 49/50/51人テストが存在
- duplicate request対策を検証
- duplicate submission対策を検証
- ranking persistenceを検証
- expiryを検証
- idempotencyを検証
- existing Supabase productionが引き続き利用可能
- GitHub Pages版が引き続き利用可能

Phase 1完了時点でCloudflare版が完全なproduction機能を持っている必要はない。

---

## 8. Phase 2 — API互換化

Phase 1完了後に別作業として実施する。

### 目的

Supabase Edge Functionsが担っているAPI処理をCloudflare Worker APIへ移す。

既存frontendから見たAPI contractを極力維持する。

対象例:

- create competition
- join
- ready
- state
- start
- submit answer
- pass
- interrupt
- finish
- results
- history
- teacher settings
- master settings

この段階でD1 persistenceを実際のWorker APIへ接続する。

### API設計原則

frontend全面rewriteは禁止。

可能な限り現在のtransport contractを維持する。

score/rankingはserver-side authorityとする。

clientから

- score
- ranking
- finish time
- correct answer

等を信用しない。

---

## 9. Phase 3 — RealtimeをDurable Objectsへ移行

Phase 2完了後に別作業として実施する。

### 目的

Supabase Realtimeを

```text
Durable Objects
+
WebSocket
```

へ置換する。

Room単位でDurable Objectを割り当てる方向を基本とする。

```text
Competition Room
      ↓
Durable Object
      ├─ WebSocket connections
      ├─ room state coordination
      ├─ start
      ├─ interrupt
      ├─ progress
      └─ finish
```

### Realtime対象

- participant ready
- competition start
- competition interrupt
- room state changes
- host progress
- finish
- results available
- reconnect
- stale state recovery

### Durable Objectの責務

Durable Objectは

```text
Realtime coordination
```

を担当する。

D1は

```text
persistent source of truth
```

を担当する。

DOだけに最終結果等を保持しない。

### Polling禁止方針

50人全員が

```text
1秒ごと
```

等でstate/ranking APIをpollingする構造は作らない。

WebSocketを基本とする。

WebSocketが切断された場合のみHTTP state fetchで復旧する。

Realtime eventを取り逃しても最終状態へ復帰できること。

---

## 10. Phase 4 — Supabase撤去

以下がCloudflare版で確認できてから実施する。

- D1 persistence
- Worker API
- teacher authentication
- participant authorization
- Durable Objects
- WebSocket
- reconnect
- 50人load test
- real browser test
- teacher flow
- student flow
- results
- review
- expiry
- physical-device smoke test
- rollback確認

その後、

- Supabase PostgreSQL
- Supabase Edge Functions
- Supabase Realtime
- Supabase Auth

への依存を順次削除する。

GitHub Pages停止もこの段階まで行わない。

---

## 11. 既存Competition仕様

明示的変更がない限り現行mainをsource of truthとする。

### Class Competition

維持する仕様:

- teacherがroom作成
- 生徒はコードまたはQR参加
- nicknameを都度入力
- 生徒の恒久的ID保存不要
- 同一roomでは全員同一問題
- 問題順序も全員共通
- IonicFormula本体準拠の難易度
- IonicFormula本体準拠のmode
- hintなし
- passあり
- 誤答ペナルティなし
- 正解数優先
- 必要に応じ完答時間を比較
- 完全同条件なら同順位
- 生徒は自身の結果のみ
- teacherはroom全体結果を閲覧

変更点:

```text
最大参加者 42 → 50
```

---

## 12. Mate Match

既存mainの仕様を維持する。

Class Competitionの50人化によってMate Matchの仕様を変更しない。

---

## 13. データ保持期間

現行仕様を維持する。

```text
Class Competition
7日

Mate Match
24時間

Waiting / temporary room
現行仕様
```

期限後はアクセス拒否可能であること。

期限切れデータを安全にcleanupできること。

---

## 14. Authentication / Authorization

最終的にはSupabase Auth依存をなくす。

ただしPhase 1ではAuth移行を実施しない。

### Teacher

現行のGoogle login体験を極力維持する。

最終構成候補として以下を比較する。

A:

```text
Worker + Google OAuth / OIDC
```

B:

```text
Cloudflare Access
```

比較観点:

- teacher操作の簡単さ
- 管理負荷
- Googleアカウントとの相性
- allowlist
- master teacher
- セキュリティ
- Cloudflare無料枠
- 将来AlkanePuzzleCompetitionでも共用可能か

認証済みGoogleユーザーであることだけでteacher権限を付与してはならない。

必ずallowlistをserver-sideで確認する。

### Student

恒久アカウントは不要。

将来的にはroom参加時に、

- room-scoped credential
- cryptographically secure random token
- expiration

等を発行する。

nicknameだけで認可しない。

他参加者の結果を閲覧できないこと。

credentialをURLへ露出しない。

---

## 15. 時刻同期

client端末時計を競技判定のauthorityにしない。

現在のSupabase版で得られた知見を維持する。

検討する時刻:

- client request dispatch
- Worker request receive
- Worker response send
- client response receive

開始時刻・締切・完答時間の最終判定はserver側とする。

端末時計変更で競技上有利にならないこと。

---

## 16. 50人対応

正式サポート対象:

```text
teacher 1
students 50
```

### 必須scenario

- 50人join
- ready
- start
- answer
- pass
- interrupt
- deadline
- finish
- result
- ranking
- review

まで完走する。

### Burst test

50 clientがほぼ同時に、

- join
- state
- ready
- submit
- final sync

を送信しても、

- 500
- 503
- deadlock相当
- lost update
- duplicate score

を大量発生させない。

### Multiple Rooms

複数room同時実行も検証する。

計測対象:

- Worker requests
- D1 rows read
- D1 rows written
- DO requests
- WebSocket connections
- CPU/runtime usage

Free枠に対する実測をdocumentationへ記録する。

---

## 17. Security

Supabase RLSがなくなるため、Worker APIでauthorizationを明示的に行う。

Endpointごとにroleを定義する。

```text
public
participant
teacher
master teacher
```

以下を禁止する。

- participant Aがparticipant Bのresultを取得
- participantがteacher API実行
- room codeだけでteacher操作
- client側score改ざん
- client側finish time改ざん
- clientからranking確定
- correct answer dataset全体のclient配布
- secret/tokenのlog出力

score / ranking / final stateはserver-sideで決定する。

---

## 18. Idempotency / 同時実行

以下を維持・検証する。

- duplicate join
- duplicate submit
- network retry
- same request retry
- double tap
- duplicate browser request
- concurrent state mutation

同じ操作のretryによって

```text
二重得点
二重submission
二重participant
```

が発生しない。

Phase 3ではroom mutation serializationにDurable Objectを活用する方向を優先する。

---

## 19. Reconnect

通信断は正常系として設計する。

対象:

- Wi-Fi瞬断
- mobile Safari background
- browser reload
- WebSocket disconnect
- duplicate tab
- sleep復帰

Realtime eventを受信できなかった場合、

```text
HTTP state recovery
```

で正しい状態へ戻れること。

---

## 20. UI維持

Cloudflare移植はbackend migrationである。

以下を原則変更しない。

- Home
- teacher UI
- QR join
- nickname flow
- game UI
- immediate review
- deferred review
- formula keyboard
- name keyboard
- result UI
- animations
- mobile layout
- touch behavior
- scoring presentation

Cloudflare移行を理由にfrontend全面rewriteを行わない。

---

## 21. QR / Camera

現在のQR参加挙動を維持する。

Regression test対象:

- manual code join
- QR join
- camera permission denied
- QR parse error
- close
- Escape
- background
- stream shutdown
- nickname transition
- mobile layout

物理iPhone/iPad Safari検証は本番移行前に実施する。

---

## 22. Testing

既存testを削除して通すことは禁止。

既存testを可能な限りbackend-neutral化する。

### 新規必須tests

#### Capacity

```text
49 accepted
50 accepted
51 rejected
```

#### Persistence

```text
competition create
join
duplicate join
submission
duplicate submission
retry
result
ranking
tie
expiry
```

#### Concurrency

```text
concurrent join
concurrent submit
same idempotency key
```

#### Security

```text
participant result isolation
teacher authorization
master authorization
invalid credential
expired credential
```

#### Competition

```text
same questions
same order
server deadline
ranking ties
```

#### Recovery

```text
stale state
reconnect
WebSocket loss + HTTP recovery
```

---

## 23. Verification

各Phase完了前に少なくとも、

```text
typecheck
unit tests
integration tests
production build
browser tests
```

を実行する。

Cloudflare本番切替前にはさらに、

```text
50-client load test
real Cloudflare D1 test
real WebSocket test
physical-device smoke test
```

を実施する。

---

## 24. Observability

本番障害調査のため最小限のstructured loggingを行う。

記録可能:

- request ID
- room ID
- operation
- HTTP status
- latency
- error category

記録禁止:

- auth token
- participant secret
- Google token
- secret key
- full answer dataset
- 不必要な個人情報

Cloudflare Dashboard等で、

- Worker request
- D1 read
- D1 write
- DO usage
- WebSocket usage

を確認可能にする。

---

## 25. Deploy

production候補のCloudflare版は、

```text
GitHub main
      ↓
Cloudflare Build
      ↓
Cloudflare Workers
```

を基本deploy経路とする。

ただし移行期間中はGitHub Pages workflowも維持する。

mainへのpushで

```text
GitHub Pages版
Cloudflare版
```

の双方が更新され得るため、双方で使用可能なbuild設定を壊さない。

---

## 26. Rollback

Cloudflare本番移行完了までは、GitHub Pages + Supabaseをrollback先として維持する。

Cloudflare側で問題が発生しても、

```text
https://koichem.github.io/IonicFormulaCompetition/
```

側の既存productionが使用できる状態を保つ。

Phase 4まではSupabase productionを破壊的変更しない。

---

## 27. GitHub Pages / Supabase coexistence

移行中は以下の2系統を明確に区別する。

### Existing production

```text
GitHub Pages
    ↓
Supabase Auth
Supabase DB
Supabase Edge Functions
Supabase Realtime
```

### Cloudflare candidate

```text
Cloudflare Workers
    ↓
D1
    ↓
将来 Durable Objects
```

Cloudflare開発のために既存productionの環境変数や設定を上書きしない。

必要ならbuild modeやconfigで明確に分離する。

---

## 28. AlkanePuzzleCompetitionへの将来展開

今回のIonicFormulaCompetitionを将来のCompetition系アプリの基盤として利用したい。

想定:

```text
Competition Core
    │
    ├─ IonicFormulaCompetition
    │
    └─ AlkanePuzzleCompetition
```

共通化候補:

- teacher auth
- room creation
- QR
- join
- participant credential
- ready
- start
- timer
- realtime
- result
- ranking
- expiry
- reconnect

ただし今回のPhase 1でCompetition frameworkを新規構築しない。

IonicFormulaCompetitionの移植完成を最優先する。

再利用可能な責務境界だけを意識する。

---

## 29. 実装禁止事項

今回のPhase 1では以下を行わない。

- Supabase削除
- Supabase Auth削除
- Supabase Edge Functions削除
- Supabase Realtime削除
- GitHub Pages停止
- UI全面rewrite
- Durable Objects本実装
- WebSocket本実装
- Google Auth移行
- teacher flow全面変更
- productionデータ強制migration
- AlkanePuzzleCompetition実装

Phase 1のscopeを守る。

---

## 30. Phase 1 実装開始前に提示する内容

コード変更前に以下をまとめて提示する。

1. Supabase persistence構造
2. PostgreSQL固有依存一覧
3. D1 schema案
4. table / index設計
5. migration対応表
6. persistence abstraction案
7. 42→50変更箇所一覧
8. D1 local/remote test計画
9. coexistence方針
10. rollback方針
11. Phase 1の具体的実装計画

その内容を確認してから実装する。

仕様判断が必要な場合は勝手に変更しない。

---

## 31. 今回確定している仕様変更

今回明示的に変更する競技仕様は以下のみ。

```text
Class Competition maximum participants:
42 → 50
```

その他の既存競技仕様は原則維持する。

---

## 32. 全移植完了条件

Phase 4まで完了した最終Cloudflare版は以下を満たす。

- Supabase DB依存なし
- Supabase Edge Functions依存なし
- Supabase Realtime依存なし
- Supabase Auth依存なし
- D1が永続データのsource of truth
- Durable Objectsによる効率的Realtime
- 50人Class Competition対応
- 51人目拒否
- existing UI互換
- teacher authorization成立
- participant authorization成立
- server-side scoring
- server-side deadline
- reconnect成立
- 50-client load test成功
- classroom workflow成功
- mobile workflow成功
- Cloudflare automatic deploy成功
- Free枠使用量計測済み
- documentation更新済み

---

## 33. 今回のCodexへの指示

この依頼ではPhase 1のみ扱う。

まずrepositoryを調査し、

```text
1. 現状分析
2. D1設計
3. 50人対応設計
4. Persistence境界
5. Test計画
6. Implementation Plan
```

まで作成する。

設計確認前に大規模実装へ入らない。

既存GitHub Pages + Supabase productionを引き続き使用可能な状態に維持することを最優先制約とする。
