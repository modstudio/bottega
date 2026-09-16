ALTER TABLE review ADD COLUMN record_id TEXT;
CREATE UNIQUE INDEX review_record_id_unique ON review(record_id);

ALTER TABLE review_lens ADD COLUMN record_id TEXT;
CREATE UNIQUE INDEX review_lens_record_id_unique ON review_lens(record_id);

ALTER TABLE review_finding ADD COLUMN record_id TEXT;
CREATE UNIQUE INDEX review_finding_record_id_unique ON review_finding(record_id);
