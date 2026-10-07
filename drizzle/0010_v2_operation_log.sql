CREATE TABLE v2_room_manifests (
  room_id text PRIMARY KEY NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('WAITING', 'PREPARING', 'COUNTDOWN', 'COLLECTING', 'FINISHED')),
  manifest_id text NOT NULL,
  evaluator_version text NOT NULL,
  grading_mode text NOT NULL CHECK (grading_mode IN ('immediate', 'deferred')),
  settings_revision integer NOT NULL CHECK (settings_revision >= 0),
  settings_json text NOT NULL CHECK (json_valid(settings_json)),
  preparation_generation integer NOT NULL DEFAULT 1 CHECK (preparation_generation >= 1),
  prepared_at_ms integer NOT NULL CHECK (prepared_at_ms >= 0),
  collecting_at_ms integer,
  cutoff_at_ms integer,
  collection_until_ms integer,
  finalized_at_ms integer,
  CHECK (collection_until_ms IS NULL OR (cutoff_at_ms IS NOT NULL AND collection_until_ms = cutoff_at_ms + 10000))
);
--> statement-breakpoint
CREATE TABLE v2_participant_progress (
  room_id text NOT NULL,
  participant_id text NOT NULL,
  ready_generation integer NOT NULL DEFAULT 0 CHECK (ready_generation >= 0),
  writer_epoch integer NOT NULL DEFAULT 1 CHECK (writer_epoch >= 1),
  ack_seq integer NOT NULL DEFAULT 0 CHECK (ack_seq >= 0),
  accepted_seq integer NOT NULL DEFAULT 0 CHECK (accepted_seq >= 0 AND accepted_seq <= ack_seq),
  answered_count integer NOT NULL DEFAULT 0 CHECK (answered_count >= 0),
  last_elapsed_ms integer NOT NULL DEFAULT 0 CHECK (last_elapsed_ms >= 0),
  last_command_id text,
  finished_elapsed_ms integer,
  finish_reason text CHECK (finish_reason IN ('completed', 'submitted', 'timeout', 'interrupted')),
  boundary_ack_at_ms integer,
  last_sync_at_ms integer,
  PRIMARY KEY (room_id, participant_id),
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX v2_participant_progress_ready_idx ON v2_participant_progress(room_id, ready_generation);
--> statement-breakpoint
CREATE TABLE v2_operations (
  room_id text NOT NULL,
  participant_id text NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  operation_id text NOT NULL,
  payload_json text NOT NULL CHECK (json_valid(payload_json)),
  elapsed_ms integer NOT NULL CHECK (elapsed_ms >= 0),
  accepted_for_score integer NOT NULL CHECK (accepted_for_score IN (0, 1)),
  received_at_ms integer NOT NULL CHECK (received_at_ms >= 0),
  PRIMARY KEY (room_id, participant_id, seq),
  UNIQUE (room_id, participant_id, operation_id),
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX v2_operations_replay_idx ON v2_operations(room_id, participant_id, elapsed_ms);
--> statement-breakpoint
CREATE TABLE v2_batch_receipts (
  room_id text NOT NULL,
  participant_id text NOT NULL,
  request_id text NOT NULL,
  body_hash text NOT NULL,
  response_json text NOT NULL CHECK (json_valid(response_json)),
  processed_at_ms integer NOT NULL CHECK (processed_at_ms >= 0),
  PRIMARY KEY (room_id, participant_id, request_id),
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE v2_final_fields (
  room_id text NOT NULL,
  participant_id text NOT NULL,
  question_id text NOT NULL,
  field_id text NOT NULL CHECK (field_id IN ('formula', 'name')),
  state text NOT NULL CHECK (state IN ('unanswered', 'correct', 'incorrect', 'passed')),
  answer_json text CHECK (answer_json IS NULL OR json_valid(answer_json)),
  PRIMARY KEY (room_id, participant_id, question_id, field_id),
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id) ON DELETE CASCADE,
  FOREIGN KEY (room_id, question_id) REFERENCES room_questions(room_id, question_id) ON DELETE CASCADE
);
