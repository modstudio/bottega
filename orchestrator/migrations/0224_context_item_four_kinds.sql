DELETE FROM context_item WHERE kind IN ('next-action','open-question');
--> statement-breakpoint
CREATE TABLE context_item_four_kinds_snapshot AS SELECT * FROM context_item;
DROP TABLE context_item;
--> statement-breakpoint
CREATE TABLE context_item (
 record_id TEXT NOT NULL PRIMARY KEY,
 holder_kind TEXT NOT NULL CHECK (holder_kind IN ('task','session','cursor')),
 holder_id TEXT NOT NULL,
 slug TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('ruling','position','fact','pointer')),
 body TEXT NOT NULL,
 source TEXT NOT NULL,
 question_number INTEGER,
 target TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(holder_kind,holder_id,slug)
);
INSERT INTO context_item SELECT * FROM context_item_four_kinds_snapshot;
CREATE INDEX context_item_holder ON context_item(holder_kind,holder_id);
DROP TABLE context_item_four_kinds_snapshot;
