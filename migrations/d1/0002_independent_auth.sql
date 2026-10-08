CREATE TABLE cf_auth_config (id INTEGER PRIMARY KEY CHECK(id=1), master_email TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE cf_google_identities (sub TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE cf_oauth_transactions (state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, nonce_hash TEXT NOT NULL, verifier TEXT NOT NULL, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX cf_oauth_expiry ON cf_oauth_transactions(expires_at_ms);
--> statement-breakpoint
CREATE TABLE cf_sessions (token_hash TEXT PRIMARY KEY, sub TEXT NOT NULL REFERENCES cf_google_identities(sub) ON DELETE CASCADE, csrf_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX cf_session_expiry ON cf_sessions(expires_at_ms);
