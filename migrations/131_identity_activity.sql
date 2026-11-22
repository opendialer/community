ALTER TABLE sessions ADD COLUMN absolute_expiry timestamptz NOT NULL DEFAULT (now()+interval '30 days');
ALTER TABLE identity_messages DROP CONSTRAINT identity_messages_purpose_check;
ALTER TABLE identity_messages ADD CHECK (purpose IN ('verify','reset','invite','existing'));
CREATE FUNCTION active_session(digest bytea) RETURNS SETOF sessions LANGUAGE plpgsql AS $$
BEGIN
  UPDATE sessions SET expires_at=least(now()+interval '7 days',absolute_expiry)
  WHERE token_hash=digest AND expires_at>now() AND expires_at<now()+interval '6 days' AND expires_at<absolute_expiry;
  RETURN QUERY SELECT s.* FROM sessions s WHERE s.token_hash=digest AND least(s.expires_at,s.absolute_expiry)>now();
END
$$;
