CREATE TABLE `site_setting_receipts` (
	`teacher_id` text NOT NULL,
	`request_id` text NOT NULL,
	`body_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`processed_at_ms` integer NOT NULL,
	PRIMARY KEY(`teacher_id`, `request_id`),
	CONSTRAINT "site_setting_receipts_json_check" CHECK(json_valid("site_setting_receipts"."result_json")),
	CONSTRAINT "site_setting_receipts_time_check" CHECK("site_setting_receipts"."processed_at_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE `site_settings` ADD `last_command_id` text;