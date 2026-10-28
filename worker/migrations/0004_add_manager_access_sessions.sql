CREATE TABLE manager_access_sessions (
  token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE
);
