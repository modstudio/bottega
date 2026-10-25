CREATE TABLE note_counter_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  project TEXT NOT NULL UNIQUE,
  next INTEGER NOT NULL CHECK (next > 0),
  project_record_id TEXT
);
INSERT INTO note_counter_uuid_key(record_id,project,next,project_record_id)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  project,next,project_record_id
FROM note_counter ORDER BY project;
DROP TABLE note_counter;
ALTER TABLE note_counter_uuid_key RENAME TO note_counter;
