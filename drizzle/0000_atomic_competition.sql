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
CREATE INDEX `command_receipts_expiry_idx` ON `command_receipts` (`expires_at_ms`);--> statement-breakpoint
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
CREATE INDEX `creation_receipts_expiry_idx` ON `creation_receipts` (`expires_at_ms`);--> statement-breakpoint
CREATE TABLE `final_results` (
	`room_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`correct_count` integer NOT NULL,
	`elapsed_cs` integer NOT NULL,
	`rank` integer NOT NULL,
	`finish_reason` text NOT NULL,
	PRIMARY KEY(`room_id`, `participant_id`),
	FOREIGN KEY (`room_id`,`participant_id`) REFERENCES `participants`(`room_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "final_results_score_check" CHECK("final_results"."correct_count" >= 0 AND "final_results"."elapsed_cs" >= 0 AND "final_results"."rank" > 0),
	CONSTRAINT "final_results_reason_check" CHECK("final_results"."finish_reason" IN ('completed', 'timeout', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `final_results_room_rank_idx` ON `final_results` (`room_id`,`rank`);--> statement-breakpoint
CREATE TABLE `participant_fields` (
	`room_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`question_id` text NOT NULL,
	`field_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`resolved_at_ms` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_command_id` text,
	PRIMARY KEY(`room_id`, `participant_id`, `question_id`, `field_id`),
	FOREIGN KEY (`room_id`,`participant_id`) REFERENCES `participants`(`room_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`room_id`,`question_id`) REFERENCES `room_questions`(`room_id`,`question_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "participant_fields_id_check" CHECK("participant_fields"."field_id" IN ('formula', 'name')),
	CONSTRAINT "participant_fields_state_check" CHECK("participant_fields"."state" IN ('pending', 'correct', 'passed', 'unanswered')),
	CONSTRAINT "participant_fields_attempt_check" CHECK("participant_fields"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `participant_fields_progress_idx` ON `participant_fields` (`room_id`,`participant_id`,`question_id`,`state`);--> statement-breakpoint
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
	`timing_source` text DEFAULT 'client' NOT NULL,
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
CREATE UNIQUE INDEX `participants_token_unique` ON `participants` (`room_id`,`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `participants_nickname_unique` ON `participants` (`room_id`,`nickname_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `participants_order_unique` ON `participants` (`room_id`,`joined_order`);--> statement-breakpoint
CREATE INDEX `participants_room_status_idx` ON `participants` (`room_id`,`status`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `room_questions_ordinal_unique` ON `room_questions` (`room_id`,`ordinal`);--> statement-breakpoint
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
	`last_command_id` text,
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
CREATE UNIQUE INDEX `rooms_public_id_unique` ON `rooms` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_join_code_unique` ON `rooms` (`join_code`);--> statement-breakpoint
CREATE INDEX `rooms_owner_active_idx` ON `rooms` (`owner_teacher_id`,`state`,`expires_at_ms`);--> statement-breakpoint
CREATE INDEX `rooms_expires_idx` ON `rooms` (`expires_at_ms`);--> statement-breakpoint
CREATE INDEX `rooms_state_deadline_idx` ON `rooms` (`state`,`deadline_at_ms`);--> statement-breakpoint
CREATE TABLE `site_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`mate_match_enabled` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "site_settings_singleton_check" CHECK("site_settings"."id" = 1),
	CONSTRAINT "site_settings_mate_check" CHECK("site_settings"."mate_match_enabled" IN (0, 1)),
	CONSTRAINT "site_settings_revision_check" CHECK("site_settings"."revision" >= 0),
	CONSTRAINT "site_settings_updated_check" CHECK("site_settings"."updated_at_ms" >= 0)
);
