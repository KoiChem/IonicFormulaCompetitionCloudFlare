# Ionic Formula Competition — Cloudflare

[Cloudflare候補版を開く](https://ionicformulacompetition.taiyakiyaita.workers.dev/)

移植元: [KoiChem/IonicFormulaCompetition](https://github.com/KoiChem/IonicFormulaCompetition)。実装・公開先はこのCloudFlareリポジトリです。

Phase 1ではReact/Vite画面をWorker Static Assetsで配信し、D1永続化基盤を実装しています。**公開画面の認証・競技・通知は既存Supabase（Class最大42名、Mate4名）を使用します。** D1側はClass50名を検証済みですが、競技HTTP API・Auth・DO/WebSocketの切替は後続Phaseです。

`/api/health` はschema準備状態、実装commit、両backendの定員を返します。それ以外の `/api` はJSON 404です。未完成のD1競技APIは公開していません。

## 開発・検証

Node.js 24、pnpm 11.19.0。

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm verify:cloudflare
pnpm exec wrangler deploy --dry-run
pnpm db:migrate:local
pnpm dev:worker
```

既存のNode SQLite/PostgreSQLテストとworkerd上のD1テストは分離しています。`test:d1:remote` は明示された専用test DBに接続します。通常のbuild/CIはremote DBを変更しません。

[移植仕様](IonicFormulaCompetition_Cloudflare_Sol_Spec.md)・[永続化対応表](docs/migration/persistence-map.md)・[Cloudflare運用](docs/migration/operations.md)・[検証記録](docs/migration/verification.md)を参照してください。旧Supabase運用資料は参照用として保持しています。
