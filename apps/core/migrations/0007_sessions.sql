-- apps/core/migrations/0007_sessions.sql
-- Slice 2: a browser that holds no token.
--
-- The core token is the credential a native shell holds in Rust. A page cannot
-- hold it — and an EventSource cannot send an Authorization header at all — so a
-- browser exchanges the token once for a cookie. Only the SHA-256 of the cookie
-- value is stored, so a leaked database yields no usable session, exactly as the
-- donor's assistant tokens did.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  cookie_hash  TEXT NOT NULL UNIQUE,
  csrf_hash    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- Verification is one indexed lookup on the hash. An attacker would need a
-- preimage of a stored hash, not a byte-by-byte comparison against a plaintext,
-- so there is no timing signal to mount an attack against.
CREATE UNIQUE INDEX idx_sessions_cookie_hash ON sessions (cookie_hash);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);
