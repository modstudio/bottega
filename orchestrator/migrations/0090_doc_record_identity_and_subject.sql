PRAGMA foreign_keys = ON;
PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
-- newRecordId() is the runtime minter; these are migration-only random UUID-v4 values.
UPDATE doc
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
CREATE TABLE doc_record_identity (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','stack','resume','canon','settings')),
  subject TEXT,
  slug TEXT NOT NULL CHECK (
    (scope = 'canon' AND length(slug) > 0 AND slug NOT GLOB '/*' AND slug NOT GLOB '*..*') OR
    (scope <> 'canon' AND length(slug) <= 64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*')
  ),
  title TEXT NOT NULL,
  project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  body TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'inject' CHECK (delivery IN ('inject','demand')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  owner TEXT,
  audience TEXT NOT NULL DEFAULT 'technical' CHECK (audience IN ('user','technical')),
  parent_id INTEGER REFERENCES doc_record_identity(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  replacement_slug TEXT,
  status TEXT NOT NULL DEFAULT 'current'
    CHECK (status IN ('draft','current','superseded','archived'))
    CHECK ((status = 'superseded') = (replacement_slug IS NOT NULL)),
  kind TEXT NOT NULL DEFAULT 'working' CHECK (kind IN ('working','article')),
  CHECK (
    (owner IS NOT NULL AND scope IN ('canon','settings') AND subject IS NULL) OR
    (owner IS NULL AND (
      (scope IN ('machine','global') AND subject IS NULL) OR
      (scope IN ('project','stack','agent','job','resume') AND subject IS NOT NULL) OR
      scope IN ('canon','settings')
    ))
  ),
  UNIQUE(scope, subject, slug)
);
--> statement-breakpoint
INSERT INTO doc_record_identity
  (id,scope,subject,slug,title,project_id,body,delivery,created_at,updated_at,record_id,
   owner,audience,parent_id,position,featured,replacement_slug,status,kind)
SELECT id,scope,subject,slug,title,project_id,body,delivery,created_at,updated_at,record_id,
  owner,audience,parent_id,position,featured,replacement_slug,status,kind
FROM doc;
--> statement-breakpoint
DROP TABLE doc;
--> statement-breakpoint
ALTER TABLE doc_record_identity RENAME TO doc;
--> statement-breakpoint
CREATE UNIQUE INDEX doc_record_id ON doc(record_id);
CREATE UNIQUE INDEX doc_address ON doc(scope, COALESCE(subject, ''), COALESCE(owner, ''), slug);
CREATE INDEX doc_parent_id ON doc(parent_id);
CREATE INDEX doc_project_id ON doc(project_id);
CREATE INDEX doc_scope_subject ON doc(scope, subject);
--> statement-breakpoint
CREATE TABLE subject (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  definition TEXT NOT NULL CHECK (
    length(trim(definition)) > 0
    AND instr(definition, char(10)) = 0
    AND instr(definition, char(13)) = 0
  ),
  position INTEGER NOT NULL CHECK (position >= 0),
  parent_id TEXT REFERENCES subject(id) ON DELETE RESTRICT,
  retired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX subject_live_name ON subject(project_id, name) WHERE retired_at IS NULL;
CREATE INDEX subject_project_position ON subject(project_id, position, id);
CREATE INDEX subject_parent_id ON subject(parent_id);
