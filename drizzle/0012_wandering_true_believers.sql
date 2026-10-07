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
