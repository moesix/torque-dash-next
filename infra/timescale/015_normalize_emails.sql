-- One-time normalization: lowercase all existing emails.
-- Idempotent: lower(email) = email for already-lowercase rows.
UPDATE "Users" SET email = lower(email) WHERE email <> lower(email);
