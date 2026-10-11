ALTER TABLE doc ADD COLUMN form TEXT CHECK (form IS NULL OR form IN ('feature','how-to','rule','model','overview'));
--> statement-breakpoint
ALTER TABLE doc ADD COLUMN article_subject_id TEXT REFERENCES subject(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE doc ADD COLUMN source_files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_files) AND json_type(source_files) = 'array');
--> statement-breakpoint
ALTER TABLE doc_revision ADD COLUMN form TEXT CHECK (form IS NULL OR form IN ('feature','how-to','rule','model','overview'));
--> statement-breakpoint
ALTER TABLE doc_revision ADD COLUMN article_subject_id TEXT REFERENCES subject(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE doc_revision ADD COLUMN related_subject_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related_subject_ids) AND json_type(related_subject_ids) = 'array');
--> statement-breakpoint
ALTER TABLE doc_revision ADD COLUMN source_files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_files) AND json_type(source_files) = 'array');
--> statement-breakpoint
CREATE TABLE doc_related_subject (
  id TEXT PRIMARY KEY,
  doc_record_id TEXT NOT NULL REFERENCES doc(record_id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES subject(id) ON DELETE RESTRICT,
  UNIQUE(doc_record_id, subject_id)
);
--> statement-breakpoint
CREATE INDEX doc_related_subject_doc ON doc_related_subject(doc_record_id);
--> statement-breakpoint
CREATE INDEX doc_related_subject_subject ON doc_related_subject(subject_id);
