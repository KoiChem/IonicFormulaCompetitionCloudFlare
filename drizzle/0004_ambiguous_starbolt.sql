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
CREATE INDEX `operation_attempts_actor_window_idx` ON `operation_attempts` (`room_id`,`actor_id`,`operation`,`processed_at_ms`);