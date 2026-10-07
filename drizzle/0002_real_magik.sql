PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_site_setting_receipts` (
	`teacher_id` text NOT NULL,
	`request_id` text NOT NULL,
	`body_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`processed_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	PRIMARY KEY(`teacher_id`, `request_id`),
	CONSTRAINT "site_setting_receipts_json_check" CHECK(json_valid("__new_site_setting_receipts"."result_json")),
	CONSTRAINT "site_setting_receipts_time_check" CHECK("__new_site_setting_receipts"."processed_at_ms" >= 0 AND "__new_site_setting_receipts"."expires_at_ms" >= "__new_site_setting_receipts"."processed_at_ms")
);
--> statement-breakpoint
INSERT INTO `__new_site_setting_receipts`("teacher_id", "request_id", "body_hash", "result_json", "processed_at_ms", "expires_at_ms") SELECT "teacher_id", "request_id", "body_hash", "result_json", "processed_at_ms", "processed_at_ms" + 7776000000 FROM `site_setting_receipts`;--> statement-breakpoint
DROP TABLE `site_setting_receipts`;--> statement-breakpoint
ALTER TABLE `__new_site_setting_receipts` RENAME TO `site_setting_receipts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `site_setting_receipts_expiry_idx` ON `site_setting_receipts` (`expires_at_ms`);
