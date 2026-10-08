CREATE TABLE cf_room_notifications (
 room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
 control_fingerprint TEXT NOT NULL,
 host_fingerprint TEXT NOT NULL,
 control_revision INTEGER NOT NULL DEFAULT 1,
 host_revision INTEGER NOT NULL DEFAULT 1,
 control_sent INTEGER NOT NULL DEFAULT 0,
 host_sent INTEGER NOT NULL DEFAULT 0
);
