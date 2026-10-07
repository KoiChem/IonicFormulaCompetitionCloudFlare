-- Empty-database D1 baseline generated from the preserved SQLite history.
-- Apply through Wrangler migrations; never apply drizzle history to this database.
CREATE TABLE `command_receipts` (
	`room_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`body_hash` text NOT NULL,
	`result_code` text NOT NULL,
	`result_json` text NOT NULL,
	`processed_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	PRIMARY KEY(`room_id`, `actor_id`, `request_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "command_receipts_json_check" CHECK(json_valid("command_receipts"."result_json")),
	CONSTRAINT "command_receipts_time_check" CHECK("command_receipts"."processed_at_ms" >= 0 AND "command_receipts"."expires_at_ms" >= "command_receipts"."processed_at_ms")
);
--> statement-breakpoint
CREATE TABLE `creation_receipts` (
	`actor_key_hash` text NOT NULL,
	`request_id` text NOT NULL,
	`body_hash` text NOT NULL,
	`room_id` text NOT NULL,
	`result_json` text NOT NULL,
	`processed_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	PRIMARY KEY(`actor_key_hash`, `request_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "creation_receipts_json_check" CHECK(json_valid("creation_receipts"."result_json")),
	CONSTRAINT "creation_receipts_time_check" CHECK("creation_receipts"."processed_at_ms" >= 0 AND "creation_receipts"."expires_at_ms" >= "creation_receipts"."processed_at_ms")
);
--> statement-breakpoint
CREATE TABLE "final_results" (
  `room_id` text NOT NULL,
  `participant_id` text NOT NULL,
  `correct_count` integer NOT NULL,
  `elapsed_cs` integer NOT NULL,
  `rank` integer NOT NULL,
  `finish_reason` text NOT NULL,
  PRIMARY KEY(`room_id`, `participant_id`),
  FOREIGN KEY (`room_id`,`participant_id`) REFERENCES `participants`(`room_id`,`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT "final_results_score_check" CHECK(`correct_count` >= 0 AND `elapsed_cs` >= 0 AND `rank` > 0),
  CONSTRAINT "final_results_reason_check" CHECK(`finish_reason` IN ('completed', 'submitted', 'timeout', 'cancelled', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE `operation_attempts` (
	`room_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`operation` text NOT NULL,
	`request_id` text NOT NULL,
	`body_hash` text NOT NULL,
	`outcome_code` text,
	`outcome_status` integer,
	`retry_after_seconds` integer,
	`processed_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	PRIMARY KEY(`room_id`, `actor_id`, `operation`, `request_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`room_id`,`actor_id`) REFERENCES `participants`(`room_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "operation_attempts_operation_check" CHECK("operation_attempts"."operation" IN ('player_action')),
	CONSTRAINT "operation_attempts_time_check" CHECK("operation_attempts"."processed_at_ms" >= 0 AND "operation_attempts"."expires_at_ms" >= "operation_attempts"."processed_at_ms")
);
--> statement-breakpoint
CREATE TABLE `participant_fields` (
	`room_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`question_id` text NOT NULL,
	`field_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`resolved_at_ms` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_command_id` text, last_answer_json text CHECK(last_answer_json IS NULL OR json_valid(last_answer_json)), last_answer_correct integer CHECK(last_answer_correct IS NULL OR last_answer_correct IN (0, 1)),
	PRIMARY KEY(`room_id`, `participant_id`, `question_id`, `field_id`),
	FOREIGN KEY (`room_id`,`participant_id`) REFERENCES `participants`(`room_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`room_id`,`question_id`) REFERENCES `room_questions`(`room_id`,`question_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "participant_fields_id_check" CHECK("participant_fields"."field_id" IN ('formula', 'name')),
	CONSTRAINT "participant_fields_state_check" CHECK("participant_fields"."state" IN ('pending', 'correct', 'passed', 'unanswered')),
	CONSTRAINT "participant_fields_attempt_check" CHECK("participant_fields"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `participants` (
	`room_id` text NOT NULL,
	`id` text NOT NULL,
	`token_hash` text NOT NULL,
	`nickname` text NOT NULL,
	`nickname_key` text NOT NULL,
	`joined_at_ms` integer NOT NULL,
	`joined_order` integer NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`current_ordinal` integer DEFAULT 0 NOT NULL,
	`correct_count` integer DEFAULT 0 NOT NULL,
	`resolved_question_count` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`last_command_id` text,
	`finished_at_ms` integer,
	`accepted_elapsed_ms` integer DEFAULT 0 NOT NULL,
	`elapsed_cs` integer DEFAULT 0 NOT NULL,
	`timing_source` text DEFAULT 'client' NOT NULL, wait_credit_ms integer NOT NULL DEFAULT 0 CONSTRAINT participants_wait_credit_check CHECK(wait_credit_ms >= 0 AND wait_credit_ms <= accepted_elapsed_ms), last_action_request_id text,
	PRIMARY KEY(`room_id`, `id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "participants_joined_check" CHECK("participants"."joined_at_ms" >= 0 AND "participants"."joined_order" > 0),
	CONSTRAINT "participants_status_check" CHECK("participants"."status" IN ('ACTIVE', 'FINISHED', 'REMOVED')),
	CONSTRAINT "participants_progress_check" CHECK("participants"."current_ordinal" >= 0 AND "participants"."correct_count" >= 0 AND "participants"."resolved_question_count" >= 0),
	CONSTRAINT "participants_revision_check" CHECK("participants"."revision" >= 0),
	CONSTRAINT "participants_elapsed_check" CHECK("participants"."accepted_elapsed_ms" >= 0 AND "participants"."elapsed_cs" >= 0),
	CONSTRAINT "participants_timing_check" CHECK("participants"."timing_source" IN ('client', 'server_fallback', 'timeout'))
);
--> statement-breakpoint
CREATE TABLE `question_profile_receipts` (
	`teacher_id` text NOT NULL,
	`request_id` text NOT NULL,
	`body_hash` text NOT NULL,
	`result_json` text NOT NULL,
	PRIMARY KEY(`teacher_id`, `request_id`),
	CONSTRAINT "question_profile_receipts_json_check" CHECK(json_valid("question_profile_receipts"."result_json"))
);
--> statement-breakpoint
CREATE TABLE `question_profiles` (
	`id` integer PRIMARY KEY NOT NULL,
	`profile_json` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`last_command_id` text,
	CONSTRAINT "question_profiles_singleton_check" CHECK("question_profiles"."id" = 1),
	CONSTRAINT "question_profiles_json_check" CHECK(json_valid("question_profiles"."profile_json")),
	CONSTRAINT "question_profiles_revision_check" CHECK("question_profiles"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `room_question_profiles` (
	`room_id` text PRIMARY KEY NOT NULL,
	`profile_json` text NOT NULL,
	`profile_revision` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "room_question_profiles_json_check" CHECK(json_valid("room_question_profiles"."profile_json")),
	CONSTRAINT "room_question_profiles_revision_check" CHECK("room_question_profiles"."profile_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `room_questions` (
	`room_id` text NOT NULL,
	`question_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`public_payload_json` text NOT NULL,
	`answer_snapshot_json` text NOT NULL,
	`field_spec_json` text NOT NULL,
	`max_score` integer NOT NULL,
	PRIMARY KEY(`room_id`, `question_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "room_questions_ordinal_check" CHECK("room_questions"."ordinal" >= 0),
	CONSTRAINT "room_questions_public_json_check" CHECK(json_valid("room_questions"."public_payload_json")),
	CONSTRAINT "room_questions_answer_json_check" CHECK(json_valid("room_questions"."answer_snapshot_json")),
	CONSTRAINT "room_questions_fields_json_check" CHECK(json_valid("room_questions"."field_spec_json")),
	CONSTRAINT "room_questions_score_check" CHECK("room_questions"."max_score" > 0)
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`join_code` text NOT NULL,
	`kind` text NOT NULL,
	`owner_teacher_id` text,
	`mate_host_id` text,
	`settings_json` text NOT NULL,
	`game_id` text NOT NULL,
	`game_version` text NOT NULL,
	`dataset_version` text NOT NULL,
	`state` text DEFAULT 'WAITING' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`max_score` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`start_at_ms` integer,
	`deadline_at_ms` integer,
	`ended_at_ms` integer,
	`expires_at_ms` integer NOT NULL,
	`last_command_id` text, end_reason text NOT NULL DEFAULT 'normal' CHECK(end_reason IN ('normal', 'interrupted')),
	CONSTRAINT "rooms_kind_check" CHECK("rooms"."kind" IN ('class', 'mate')),
	CONSTRAINT "rooms_state_check" CHECK("rooms"."state" IN ('CREATED', 'WAITING', 'COUNTDOWN', 'RUNNING', 'FINISHED', 'CANCELLED', 'EXPIRED')),
	CONSTRAINT "rooms_revision_check" CHECK("rooms"."revision" >= 0),
	CONSTRAINT "rooms_score_check" CHECK("rooms"."max_score" > 0),
	CONSTRAINT "rooms_created_check" CHECK("rooms"."created_at_ms" >= 0),
	CONSTRAINT "rooms_expiry_check" CHECK("rooms"."expires_at_ms" >= "rooms"."created_at_ms"),
	CONSTRAINT "rooms_owner_check" CHECK(("rooms"."kind" = 'class' AND "rooms"."owner_teacher_id" IS NOT NULL AND "rooms"."mate_host_id" IS NULL) OR ("rooms"."kind" = 'mate' AND "rooms"."owner_teacher_id" IS NULL AND "rooms"."mate_host_id" IS NOT NULL)),
	CONSTRAINT "rooms_schedule_check" CHECK("rooms"."deadline_at_ms" IS NULL OR ("rooms"."start_at_ms" IS NOT NULL AND "rooms"."deadline_at_ms" > "rooms"."start_at_ms"))
);
--> statement-breakpoint
CREATE TABLE "site_setting_receipts" (
	`teacher_id` text NOT NULL,
	`request_id` text NOT NULL,
	`body_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`processed_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	PRIMARY KEY(`teacher_id`, `request_id`),
	CONSTRAINT "site_setting_receipts_json_check" CHECK(json_valid("site_setting_receipts"."result_json")),
	CONSTRAINT "site_setting_receipts_time_check" CHECK("site_setting_receipts"."processed_at_ms" >= 0 AND "site_setting_receipts"."expires_at_ms" >= "site_setting_receipts"."processed_at_ms")
);
--> statement-breakpoint
CREATE TABLE `site_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`mate_match_enabled` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at_ms` integer NOT NULL, `last_command_id` text,
	CONSTRAINT "site_settings_singleton_check" CHECK("site_settings"."id" = 1),
	CONSTRAINT "site_settings_mate_check" CHECK("site_settings"."mate_match_enabled" IN (0, 1)),
	CONSTRAINT "site_settings_revision_check" CHECK("site_settings"."revision" >= 0),
	CONSTRAINT "site_settings_updated_check" CHECK("site_settings"."updated_at_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE `teacher_allowlist` (
	`id` integer PRIMARY KEY NOT NULL,
	`emails_json` text DEFAULT '[]' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`last_request_id` text,
	`last_body_hash` text,
	CONSTRAINT "teacher_allowlist_singleton" CHECK("teacher_allowlist"."id" = 1),
	CONSTRAINT "teacher_allowlist_revision" CHECK("teacher_allowlist"."revision" >= 0),
	CONSTRAINT "teacher_allowlist_json" CHECK(json_valid("teacher_allowlist"."emails_json") AND json_type("teacher_allowlist"."emails_json") = 'array')
);
--> statement-breakpoint
CREATE TABLE v2_batch_receipts (
  room_id text NOT NULL,
  participant_id text NOT NULL,
  request_id text NOT NULL,
  body_hash text NOT NULL,
  response_json text NOT NULL CHECK (json_valid(response_json)),
  processed_at_ms integer NOT NULL CHECK (processed_at_ms >= 0),
  PRIMARY KEY (room_id, participant_id, request_id),
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE v2_final_fields (
  room_id text NOT NULL,
  participant_id text NOT NULL,
  question_id text NOT NULL,
  field_id text NOT NULL CHECK (field_id IN ('formula', 'name')),
  state text NOT NULL CHECK (state IN ('unanswered', 'correct', 'incorrect', 'passed')),
  answer_json text CHECK (answer_json IS NULL OR json_valid(answer_json)),
  PRIMARY KEY (room_id, participant_id, question_id, field_id),
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id) ON DELETE CASCADE,
  FOREIGN KEY (room_id, question_id) REFERENCES room_questions(room_id, question_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE v2_operations (
  room_id text NOT NULL,
  participant_id text NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  operation_id text NOT NULL,
  payload_json text NOT NULL CHECK (json_valid(payload_json)),
  elapsed_ms integer NOT NULL CHECK (elapsed_ms >= 0),
  accepted_for_score integer NOT NULL CHECK (accepted_for_score IN (0, 1)),
  received_at_ms integer NOT NULL CHECK (received_at_ms >= 0),
  PRIMARY KEY (room_id, participant_id, seq),
  UNIQUE (room_id, participant_id, operation_id),
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE v2_participant_progress (
  room_id text NOT NULL,
  participant_id text NOT NULL,
  ready_generation integer NOT NULL DEFAULT 0 CHECK (ready_generation >= 0),
  writer_epoch integer NOT NULL DEFAULT 1 CHECK (writer_epoch >= 1),
  ack_seq integer NOT NULL DEFAULT 0 CHECK (ack_seq >= 0),
  accepted_seq integer NOT NULL DEFAULT 0 CHECK (accepted_seq >= 0 AND accepted_seq <= ack_seq),
  answered_count integer NOT NULL DEFAULT 0 CHECK (answered_count >= 0),
  last_elapsed_ms integer NOT NULL DEFAULT 0 CHECK (last_elapsed_ms >= 0),
  last_command_id text,
  finished_elapsed_ms integer,
  finish_reason text CHECK (finish_reason IN ('completed', 'submitted', 'timeout', 'interrupted')),
  boundary_ack_at_ms integer,
  last_sync_at_ms integer,
  PRIMARY KEY (room_id, participant_id),
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE v2_room_manifests (
  room_id text PRIMARY KEY NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('WAITING', 'PREPARING', 'COUNTDOWN', 'COLLECTING', 'FINISHED')),
  manifest_id text NOT NULL,
  evaluator_version text NOT NULL,
  grading_mode text NOT NULL CHECK (grading_mode IN ('immediate', 'deferred')),
  settings_revision integer NOT NULL CHECK (settings_revision >= 0),
  settings_json text NOT NULL CHECK (json_valid(settings_json)),
  preparation_generation integer NOT NULL DEFAULT 1 CHECK (preparation_generation >= 1),
  prepared_at_ms integer NOT NULL CHECK (prepared_at_ms >= 0),
  collecting_at_ms integer,
  cutoff_at_ms integer,
  collection_until_ms integer,
  finalized_at_ms integer,
  CHECK (collection_until_ms IS NULL OR (cutoff_at_ms IS NOT NULL AND collection_until_ms = cutoff_at_ms + 10000))
);
--> statement-breakpoint
CREATE INDEX `command_receipts_actor_window_idx` ON `command_receipts` (`room_id`,`actor_id`,`processed_at_ms`);
--> statement-breakpoint
CREATE INDEX `command_receipts_expiry_idx` ON `command_receipts` (`expires_at_ms`);
--> statement-breakpoint
CREATE INDEX `creation_receipts_expiry_idx` ON `creation_receipts` (`expires_at_ms`);
--> statement-breakpoint
CREATE INDEX `final_results_room_rank_idx` ON `final_results` (`room_id`,`rank`);
--> statement-breakpoint
CREATE INDEX `operation_attempts_actor_window_idx` ON `operation_attempts` (`room_id`,`actor_id`,`operation`,`processed_at_ms`);
--> statement-breakpoint
CREATE INDEX `participant_fields_progress_idx` ON `participant_fields` (`room_id`,`participant_id`,`question_id`,`state`);
--> statement-breakpoint
CREATE UNIQUE INDEX `participants_nickname_unique` ON `participants` (`room_id`,`nickname_key`) WHERE `status` != 'REMOVED';
--> statement-breakpoint
CREATE UNIQUE INDEX `participants_order_unique` ON `participants` (`room_id`,`joined_order`);
--> statement-breakpoint
CREATE INDEX `participants_room_status_idx` ON `participants` (`room_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `participants_token_unique` ON `participants` (`room_id`,`token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_questions_ordinal_unique` ON `room_questions` (`room_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `rooms_expires_idx` ON `rooms` (`expires_at_ms`);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_join_code_unique` ON `rooms` (`join_code`);
--> statement-breakpoint
CREATE INDEX `rooms_owner_active_idx` ON `rooms` (`owner_teacher_id`,`state`,`expires_at_ms`);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_public_id_unique` ON `rooms` (`public_id`);
--> statement-breakpoint
CREATE INDEX `rooms_state_deadline_idx` ON `rooms` (`state`,`deadline_at_ms`);
--> statement-breakpoint
CREATE INDEX `site_setting_receipts_expiry_idx` ON `site_setting_receipts` (`expires_at_ms`);
--> statement-breakpoint
CREATE INDEX v2_operations_replay_idx ON v2_operations(room_id, participant_id, elapsed_ms);
--> statement-breakpoint
CREATE INDEX v2_participant_progress_ready_idx ON v2_participant_progress(room_id, ready_generation);
