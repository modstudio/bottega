CREATE TABLE doc_new (
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
  record_id TEXT,
  owner TEXT,
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
INSERT INTO doc_new
  (id,scope,subject,slug,title,project_id,body,delivery,created_at,updated_at,record_id,owner)
SELECT id,scope,subject,slug,title,project_id,body,delivery,created_at,updated_at,record_id,owner
FROM doc;
--> statement-breakpoint
DROP TABLE doc;
--> statement-breakpoint
ALTER TABLE doc_new RENAME TO doc;
--> statement-breakpoint
CREATE INDEX doc_scope_subject ON doc(scope, subject);
--> statement-breakpoint
CREATE INDEX doc_project_id ON doc(project_id);
--> statement-breakpoint
CREATE UNIQUE INDEX doc_address ON doc(scope, COALESCE(subject, ''), COALESCE(owner, ''), slug);
--> statement-breakpoint
CREATE TABLE doc_revision_new (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','stack','resume','canon','settings')),
  subject TEXT,
  slug TEXT NOT NULL CHECK (
    (scope = 'canon' AND length(slug) > 0 AND slug NOT GLOB '/*' AND slug NOT GLOB '*..*') OR
    (scope <> 'canon' AND length(slug) <= 64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*')
  ),
  project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  op TEXT NOT NULL CHECK (op IN ('create','set','consume','delete','restore','import','backfill')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'inject' CHECK (delivery IN ('inject','demand')),
  author TEXT NOT NULL CHECK (length(trim(author)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT,
  owner TEXT,
  CHECK (
    (owner IS NOT NULL AND scope IN ('canon','settings') AND subject IS NULL) OR
    (owner IS NULL AND (
      (scope IN ('machine','global') AND subject IS NULL) OR
      (scope IN ('project','stack','agent','job','resume') AND subject IS NOT NULL) OR
      scope IN ('canon','settings')
    ))
  )
);
--> statement-breakpoint
INSERT INTO doc_revision_new
  (id,doc_id,scope,subject,slug,project_id,op,title,body,delivery,author,reason,session_id,at,record_id,owner)
SELECT id,doc_id,scope,subject,slug,project_id,op,title,body,delivery,author,reason,session_id,at,record_id,owner
FROM doc_revision;
--> statement-breakpoint
DROP TABLE doc_revision;
--> statement-breakpoint
ALTER TABLE doc_revision_new RENAME TO doc_revision;
--> statement-breakpoint
CREATE INDEX doc_revision_doc ON doc_revision(doc_id, id);
--> statement-breakpoint
CREATE INDEX doc_revision_address ON doc_revision(scope, COALESCE(subject, ''), COALESCE(owner, ''), slug, id);
--> statement-breakpoint
CREATE INDEX doc_revision_project_id ON doc_revision(project_id);
