ALTER TABLE participants ADD COLUMN wait_credit_ms integer NOT NULL DEFAULT 0 CONSTRAINT participants_wait_credit_check CHECK(wait_credit_ms >= 0 AND wait_credit_ms <= accepted_elapsed_ms);
--> statement-breakpoint
ALTER TABLE participants ADD COLUMN last_action_request_id text;
