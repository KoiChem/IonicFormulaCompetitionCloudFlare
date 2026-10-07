DROP INDEX `participants_nickname_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `participants_nickname_unique` ON `participants` (`room_id`,`nickname_key`) WHERE `status` != 'REMOVED';
