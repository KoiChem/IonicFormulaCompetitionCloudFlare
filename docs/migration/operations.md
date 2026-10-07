# Cloudflare Phase 1 operations

## Targets

| Environment | Worker | D1 name / UUID | Purpose |
|---|---|---|---|
| local | local workerd | local storage only | development |
| remote test | no permanent public test Worker | ionic-formula-competition-phase1-test / 908e08e6-0b70-454b-a97d-0528fde1706e | isolated contract tests |
| candidate (default) | ionicformulacompetition | ionic-formula-competition / a0475c35-c39b-4c73-b7e2-51e05a899483 | Phase 1 schema + health, no competition API |

Account ID: 57b6032a34645abf597e8662b0e70ede. Default is a **candidate**, not a D1 production competition backend. Existing Supabase and GitHub Pages remain separate. No production-data copy is performed.

## Migration

```sh
pnpm db:migrate:local
pnpm db:migrate:test
pnpm test:d1:remote
# Only after inspecting the empty intended candidate database:
pnpm exec wrangler d1 migrations apply DB --remote
```

Only `migrations/d1/` is applied. `drizzle/` is schema reference. Applying the migration again must say no migrations to apply. Never rewrite an applied migration. Future changes get a new numbered migration. Build/CI/deploy never run remote migrations as a side effect.

Remote tests verify the test UUID and remote binding; there is no default DB fallback. They refuse to start with existing rooms. Cleanup deletes only fixed IDs created by the test workflow (`room-1`, `expired-0` through `expired-58`), with FK cascades; it does not delete the database or schema. Do not reuse this dedicated DB for other data.

## Release

```sh
pnpm verify:cloudflare
pnpm exec wrangler deploy --dry-run
pnpm deploy:cloudflare
```

Deploy stamps `/api/health.build` with Git HEAD. Worker runtime bundle contains native Request/Response/D1/Assets and public config only; no PostgreSQL driver or Deno entry. `/api/health` returns 200 only when core schema is present, 503 otherwise. Other API paths return JSON 404; POST health returns 405. Health checks readiness, not SQL schema completeness or competitive API availability.

Workers Builds must connect `KoiChem/IonicFormulaCompetitionCloudFlare`, production branch `main`, root `/`, build `pnpm run verify:cloudflare`, deploy `pnpm run deploy:cloudflare`. Preview builds are disabled for this Phase 1 candidate. GitHub Actions validates independently and does not deploy the old Pages workflow.

## Rollback / next Phase

Previous static version: 5be69e0a-86ee-4d08-815d-29ba324abbd7. Wrangler deployment history identifies candidate versions. Rollback the Worker with `wrangler rollback <version-id>` after checking the intended version; it does not roll back D1 schema. Phase 1 D1 contains no live competition rooms. Keep the additive baseline in place.

Phase 2 must settle shared teacher authority, identity/session security, elapsed-time trust and per-question answer visibility. Phase 3 must supply durable notifications and reconnection. No old Supabase/Auth/Pages shutdown or deletion is authorized by this release.
