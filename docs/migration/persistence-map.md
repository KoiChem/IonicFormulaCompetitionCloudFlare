# Persistence migration map — Phase 1

Native D1 uses existing SQLite names/constraints and parameterized statements.

| Source | D1 disposition |
|---|---|
| rooms, participants, room_questions | Baseline; revision/CAS, active nickname partial unique, token/order unique |
| participant_fields, final_results | Baseline; composite FK/cascade, submitted/interrupted result reasons |
| command_receipts, creation_receipts | Baseline; command and atomic creation replay |
| v2_room_manifests, v2_participant_progress | Baseline; preparation generation, writer epoch, sequence and collection boundary |
| v2_operations, v2_batch_receipts, v2_final_fields | Baseline; operation JSON batch insert, replay receipt and private review |
| site_settings, site_setting_receipts | Baseline; revision and expiry |
| teacher_allowlist | Baseline contract only; not a new independent live authority |
| question_profiles, question_profile_receipts, room_question_profiles | Baseline; source profile snapshots |
| operation_attempts | Baseline; existing command rate bookkeeping |
| app_auth_config, app_teacher_bindings, app_memberships | Supabase auth-specific; Phase 2 identity mapping, not copied |
| app_room_topics, app_outbox, app_broadcast_budget | Supabase broadcast-specific; Phase 3 outbox/DO design, not blindly copied |
| app_audit, app_request_limits, app_maintenance | Supabase gateway/maintenance-specific; Phase 2/3 API scheduling design |
| shared_teacher_callers, shared_teacher_requests | Shared authority protocol; Phase 2 caller inventory required |
| native PostgreSQL room functions / RLS / publication | No D1 equivalent SQL function; command guards / Worker authorization / DO notifications |
| postgres-runtime request transaction, advisory lock | Not imported into Worker execution graph. Native D1 batch is the atomic unit |

SQLite migrations 0000–0012 define the domain schema. Supabase core is their generated PostgreSQL equivalent; later migrations add platform responsibilities. Empty-D1 baseline is generated offline from all SQLite migrations, preserving columns/indexes/checks, without migration-time table rebuilding or foreign_keys=OFF. Workerd tests compare table/column/index sets and verify constraints, rollback and cascade.

HTTP identity and actual live authorizations are outside Phase 1. Domain/security contract tests are not evidence of a deployed D1 competition API.
