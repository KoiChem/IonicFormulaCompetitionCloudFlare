PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_final_results` (
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
);--> statement-breakpoint
INSERT INTO `__new_final_results` SELECT * FROM `final_results`;--> statement-breakpoint
DROP TABLE `final_results`;--> statement-breakpoint
ALTER TABLE `__new_final_results` RENAME TO `final_results`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `final_results_room_rank_idx` ON `final_results` (`room_id`,`rank`);
