ALTER TABLE participant_fields ADD COLUMN last_answer_json text CHECK(last_answer_json IS NULL OR json_valid(last_answer_json));--> statement-breakpoint
ALTER TABLE participant_fields ADD COLUMN last_answer_correct integer CHECK(last_answer_correct IS NULL OR last_answer_correct IN (0, 1));
