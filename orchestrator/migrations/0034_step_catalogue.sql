CREATE TABLE step_catalogue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE step_catalogue_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalogue_id INTEGER NOT NULL REFERENCES step_catalogue(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','production','retired')),
  definition TEXT NOT NULL,
  author TEXT NOT NULL CHECK (length(trim(author)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at TEXT NOT NULL,
  promoted_at TEXT,
  retired_at TEXT,
  UNIQUE(catalogue_id, n)
);
--> statement-breakpoint
CREATE TABLE step_catalogue_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalogue_id INTEGER NOT NULL REFERENCES step_catalogue(id) ON DELETE CASCADE,
  version_n INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('set','fork','import','promote','retire')),
  author TEXT NOT NULL CHECK (length(trim(author)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  FOREIGN KEY(catalogue_id, version_n) REFERENCES step_catalogue_version(catalogue_id, n)
);
--> statement-breakpoint
CREATE UNIQUE INDEX step_catalogue_one_production
  ON step_catalogue_version(catalogue_id) WHERE status = 'production';
--> statement-breakpoint
CREATE INDEX step_catalogue_version_catalogue ON step_catalogue_version(catalogue_id, n);
--> statement-breakpoint
CREATE INDEX step_catalogue_event_version ON step_catalogue_event(catalogue_id, version_n, id);
--> statement-breakpoint
CREATE TABLE doc_new (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','stack','resume','canon')),
  subject TEXT,
  slug TEXT NOT NULL CHECK (
    (scope = 'canon' AND length(slug) > 0 AND slug NOT GLOB '/*' AND slug NOT GLOB '*..*') OR
    (scope <> 'canon' AND length(slug) <= 64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*')
  ), title TEXT NOT NULL, project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  body TEXT NOT NULL, delivery TEXT NOT NULL DEFAULT 'inject' CHECK (delivery IN ('inject','demand')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((scope IN ('machine','global') AND subject IS NULL) OR
    (scope IN ('project','stack','agent','job','resume') AND subject IS NOT NULL) OR scope = 'canon'),
  UNIQUE(scope, subject, slug)
);
--> statement-breakpoint
INSERT INTO doc_new SELECT * FROM doc;
--> statement-breakpoint
DROP TABLE doc;
--> statement-breakpoint
ALTER TABLE doc_new RENAME TO doc;
--> statement-breakpoint
CREATE INDEX doc_scope_subject ON doc(scope, subject);
--> statement-breakpoint
CREATE INDEX doc_project_id ON doc(project_id);
--> statement-breakpoint
CREATE UNIQUE INDEX doc_address ON doc(scope, COALESCE(subject, ''), slug);
--> statement-breakpoint
CREATE TABLE doc_revision_new (
  id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','stack','resume','canon')),
  subject TEXT, slug TEXT NOT NULL CHECK (
    (scope = 'canon' AND length(slug) > 0 AND slug NOT GLOB '/*' AND slug NOT GLOB '*..*') OR
    (scope <> 'canon' AND length(slug) <= 64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*')
  ), project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  op TEXT NOT NULL CHECK (op IN ('create','set','consume','delete','restore','import','backfill')),
  title TEXT NOT NULL, body TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'inject' CHECK (delivery IN ('inject','demand')),
  author TEXT NOT NULL CHECK (length(trim(author)) > 0), reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  session_id TEXT, at TEXT NOT NULL,
  CHECK ((scope IN ('machine','global') AND subject IS NULL) OR
    (scope IN ('project','stack','agent','job','resume') AND subject IS NOT NULL) OR scope = 'canon')
);
--> statement-breakpoint
INSERT INTO doc_revision_new SELECT * FROM doc_revision;
--> statement-breakpoint
DROP TABLE doc_revision;
--> statement-breakpoint
ALTER TABLE doc_revision_new RENAME TO doc_revision;
--> statement-breakpoint
CREATE INDEX doc_revision_doc ON doc_revision(doc_id, id);
--> statement-breakpoint
CREATE INDEX doc_revision_address ON doc_revision(scope, subject, slug, id);
--> statement-breakpoint
CREATE INDEX doc_revision_project_id ON doc_revision(project_id);
