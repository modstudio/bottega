ALTER TABLE doc ADD COLUMN audience TEXT NOT NULL DEFAULT 'technical' CHECK (audience IN ('user','technical'));
--> statement-breakpoint
ALTER TABLE doc ADD COLUMN parent_id INTEGER REFERENCES doc(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE doc ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX doc_parent_id ON doc(parent_id);
--> statement-breakpoint
ALTER TABLE doc_revision ADD COLUMN audience TEXT NOT NULL DEFAULT 'technical' CHECK (audience IN ('user','technical'));
--> statement-breakpoint
ALTER TABLE doc_revision ADD COLUMN parent_id INTEGER;
--> statement-breakpoint
ALTER TABLE doc_revision ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
