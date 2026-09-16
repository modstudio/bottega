ALTER TABLE landing ADD COLUMN record_id TEXT;
CREATE UNIQUE INDEX landing_record_id_unique ON landing(record_id);

ALTER TABLE landing_override ADD COLUMN record_id TEXT;
CREATE UNIQUE INDEX landing_override_record_id_unique ON landing_override(record_id);

ALTER TABLE landing_review_carry ADD COLUMN record_id TEXT;
CREATE UNIQUE INDEX landing_review_carry_record_id_unique ON landing_review_carry(record_id);

ALTER TABLE contention ADD COLUMN record_id TEXT;
CREATE UNIQUE INDEX contention_record_id_unique ON contention(record_id);

ALTER TABLE test_flake ADD COLUMN record_id TEXT;
CREATE UNIQUE INDEX test_flake_record_id_unique ON test_flake(record_id);
