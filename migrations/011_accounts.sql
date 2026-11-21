ALTER TABLE users ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE identity_messages ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
