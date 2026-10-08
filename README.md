# Ionic Formula Competition — Cloudflare Independent

[Cloudflare版を開く](https://ionicformulacompetition.taiyakiyaita.workers.dev/)

実装・公開先は [KoiChem/IonicFormulaCompetitionCloudFlare](https://github.com/KoiChem/IonicFormulaCompetitionCloudFlare)。移植元は [KoiChem/IonicFormulaCompetition](https://github.com/KoiChem/IonicFormulaCompetition) です。

独立版のコードは React/Vite Static Assets、Worker API、D1、Room Durable Object / Hibernation WebSocket、直接Google OIDCを使用します。通常運用でSupabaseへ通信しません。Class50名、Mate4名。教員権限と結果は新D1で管理し、旧版データを共有・移送しません。旧GitHub Pages / Supabase版はそのまま運用できます。

公開への切替状況と実Google/HTTPSの確認状況は[独立版の検証記録](docs/migration/independent-verification.md)を参照してください。コード・ローカルfixtureの成功だけで公開済みとは扱いません。

## 開発・検証

Node.js 24、pnpm 11.19.0。

```sh
pnpm install --frozen-lockfile
pnpm verify:cloudflare
pnpm db:migrate:local
pnpm dev:worker
pnpm exec wrangler deploy --dry-run
```

Frontendは同一origin `/api` を使い、VITE認証キーは不要です。Google client/master設定はWorker secretへ保存します。`pnpm dev`は画面開発用で、競技の統合検証にはWorkerとD1が必要です。

`/api/health` は独立schema・Google設定・DOの準備、release SHA、定員を返し、未設定時503です。通常のCI/buildはremote DBを変更しません。

[承認済み独立版仕様](docs/superpowers/specs/2026-10-08-cloudflare-independent-design.md)・[実装計画](docs/superpowers/plans/2026-10-08-cloudflare-independent.md)・[独立版運用](docs/migration/independent-operations.md)を参照してください。初期移植仕様やSupabase資料は履歴・参照用として保持しています。
