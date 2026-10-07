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
