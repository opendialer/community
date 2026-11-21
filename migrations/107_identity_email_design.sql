-- Already attempted messages must retry their original Resend payload.
ALTER TABLE identity_messages ADD COLUMN legacy_email_design boolean NOT NULL DEFAULT false;
UPDATE identity_messages SET legacy_email_design=true
WHERE attempts>0 AND sent_at IS NULL AND consumed_at IS NULL AND expires_at>now();
