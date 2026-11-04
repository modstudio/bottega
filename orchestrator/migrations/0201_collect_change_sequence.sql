CREATE TABLE collect_change_counter (
  record_id TEXT NOT NULL PRIMARY KEY,
  value INTEGER NOT NULL
);
--> statement-breakpoint
ALTER TABLE run ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE question ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
-- BACKFILL
UPDATE run SET change_seq=number WHERE change_seq=0;
UPDATE question SET change_seq=(SELECT COALESCE(MAX(number),0) FROM run)+number WHERE change_seq=0;
INSERT OR IGNORE INTO collect_change_counter(record_id,value)
VALUES ('01990000-0000-7000-8000-000000002099',0);
UPDATE collect_change_counter SET value=
  (SELECT MAX(value) FROM (
    SELECT COALESCE(MAX(change_seq),0) value FROM run
    UNION ALL SELECT COALESCE(MAX(change_seq),0) FROM question
  ))
WHERE value < (SELECT MAX(value) FROM (
  SELECT COALESCE(MAX(change_seq),0) value FROM run
  UNION ALL SELECT COALESCE(MAX(change_seq),0) FROM question
));
-- /BACKFILL
--> statement-breakpoint
CREATE TRIGGER run_collect_change_insert AFTER INSERT ON run BEGIN
  UPDATE collect_change_counter SET value=value+1;
  UPDATE run SET change_seq=(SELECT value FROM collect_change_counter)
    WHERE record_id=NEW.record_id;
END;
--> statement-breakpoint
CREATE TRIGGER run_collect_change_update AFTER UPDATE ON run
WHEN NEW.change_seq=OLD.change_seq BEGIN
  UPDATE collect_change_counter SET value=value+1;
  UPDATE run SET change_seq=(SELECT value FROM collect_change_counter)
    WHERE record_id=NEW.record_id;
END;
--> statement-breakpoint
CREATE TRIGGER question_collect_change_insert AFTER INSERT ON question BEGIN
  UPDATE collect_change_counter SET value=value+1;
  UPDATE question SET change_seq=(SELECT value FROM collect_change_counter)
    WHERE record_id=NEW.record_id;
END;
--> statement-breakpoint
CREATE TRIGGER question_collect_change_update AFTER UPDATE ON question
WHEN NEW.change_seq=OLD.change_seq BEGIN
  UPDATE collect_change_counter SET value=value+1;
  UPDATE question SET change_seq=(SELECT value FROM collect_change_counter)
    WHERE record_id=NEW.record_id;
END;
--> statement-breakpoint
CREATE INDEX run_change_seq ON run(change_seq);
CREATE INDEX question_change_seq ON question(change_seq);
