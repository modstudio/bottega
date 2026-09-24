ALTER TABLE doc ADD COLUMN owner TEXT;
--> statement-breakpoint
ALTER TABLE doc_revision ADD COLUMN owner TEXT;
--> statement-breakpoint
DROP INDEX IF EXISTS doc_address;
--> statement-breakpoint
CREATE UNIQUE INDEX doc_address ON doc(scope, COALESCE(subject, ''), COALESCE(owner, ''), slug);
--> statement-breakpoint
DROP INDEX doc_revision_address;
--> statement-breakpoint
CREATE INDEX doc_revision_address ON doc_revision(scope, COALESCE(subject, ''), COALESCE(owner, ''), slug, id);
