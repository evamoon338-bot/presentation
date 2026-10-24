-- Adds Google sign-in support.
-- Google-only accounts have no password, so the password columns must allow NULL.
-- SQLite cannot drop NOT NULL in place, so users is rebuilt and copied over.

PRAGMA foreign_keys=OFF;

CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT,
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  profile_photo TEXT,
  about_me TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT 'friends',
  email_notifications INTEGER NOT NULL DEFAULT 1,
  product_updates INTEGER NOT NULL DEFAULT 0,
  show_email INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO users_new (
  id,email,display_name,password_salt,password_hash,profile_photo,
  about_me,audience,email_notifications,product_updates,show_email,created_at
)
SELECT
  id,email,display_name,password_salt,password_hash,profile_photo,
  about_me,audience,email_notifications,product_updates,show_email,created_at
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

PRAGMA foreign_keys=ON;
