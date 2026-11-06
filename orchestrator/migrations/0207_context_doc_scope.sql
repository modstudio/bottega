-- DEV-1844: context items are documents addressed by holder.
CREATE TABLE doc_context_scope_snapshot AS SELECT * FROM doc;
CREATE TABLE doc_revision_context_scope_snapshot AS SELECT * FROM doc_revision;
CREATE TABLE doc_related_subject_context_scope_snapshot AS SELECT * FROM doc_related_subject;
DROP TABLE doc_revision;
DROP TABLE doc_related_subject;
DROP TABLE doc;
--> statement-breakpoint
CREATE TABLE doc (
 record_id TEXT NOT NULL PRIMARY KEY,
 scope TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','stack','resume','canon','settings','context')),
 subject TEXT, slug TEXT NOT NULL CHECK ((scope='canon' AND length(slug)>0 AND slug NOT GLOB '/*' AND slug NOT GLOB '*..*') OR (scope<>'canon' AND length(slug)<=64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*')),
 title TEXT NOT NULL, project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
 body TEXT NOT NULL, delivery TEXT NOT NULL DEFAULT 'inject' CHECK (delivery IN ('inject','demand')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, owner TEXT,
 audiences TEXT NOT NULL CHECK (json_valid(audiences) AND json_type(audiences)='array' AND json_array_length(audiences)>0),
 parent_record_id TEXT REFERENCES doc(record_id) ON DELETE RESTRICT,
 position INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)), replacement_slug TEXT,
 status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('draft','current','superseded','archived')) CHECK ((status='superseded')=(replacement_slug IS NOT NULL)),
 kind TEXT NOT NULL DEFAULT 'working' CHECK (kind IN ('working','article')),
 form TEXT CHECK (form IS NULL OR form IN ('feature','how-to','rule','model','overview','reference')),
 article_subject_id TEXT REFERENCES subject(id) ON DELETE RESTRICT,
 source_files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_files) AND json_type(source_files)='array'), checked_against_commit TEXT, summary TEXT, space_id TEXT,
 CHECK ((owner IS NOT NULL AND scope IN ('canon','settings') AND subject IS NULL) OR (owner IS NULL AND ((scope IN ('machine','global') AND subject IS NULL) OR (scope IN ('project','stack','agent','job','resume','context') AND subject IS NOT NULL) OR scope IN ('canon','settings')))),
 UNIQUE(scope,subject,slug)
);
INSERT INTO doc SELECT * FROM doc_context_scope_snapshot;
CREATE TABLE doc_related_subject (
 id TEXT PRIMARY KEY, doc_record_id TEXT NOT NULL REFERENCES doc(record_id) ON DELETE CASCADE,
 subject_id TEXT NOT NULL REFERENCES subject(id) ON DELETE RESTRICT, record_id TEXT NOT NULL,
 UNIQUE(doc_record_id,subject_id)
);
INSERT INTO doc_related_subject SELECT * FROM doc_related_subject_context_scope_snapshot;
CREATE TABLE doc_revision (
 record_id TEXT NOT NULL PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
 doc_record_id TEXT REFERENCES doc(record_id) ON DELETE SET NULL,
 scope TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','stack','resume','canon','settings','context')),
 subject TEXT, slug TEXT NOT NULL CHECK ((scope='canon' AND length(slug)>0 AND slug NOT GLOB '/*' AND slug NOT GLOB '*..*') OR (scope<>'canon' AND length(slug)<=64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*')),
 project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
 op TEXT NOT NULL CHECK (op IN ('create','set','consume','delete','restore','import','backfill')),
 title TEXT NOT NULL, body TEXT NOT NULL, delivery TEXT NOT NULL DEFAULT 'inject' CHECK (delivery IN ('inject','demand')),
 author TEXT NOT NULL CHECK (length(trim(author))>0), reason TEXT NOT NULL CHECK (length(trim(reason))>0), session_id TEXT, at TEXT NOT NULL, owner TEXT,
 audiences TEXT NOT NULL CHECK (json_valid(audiences) AND json_type(audiences)='array' AND json_array_length(audiences)>0),
 parent_record_id TEXT REFERENCES doc(record_id) ON DELETE SET NULL,
 position INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)), replacement_slug TEXT,
 status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('draft','current','superseded','archived')) CHECK ((status='superseded')=(replacement_slug IS NOT NULL)),
 kind TEXT NOT NULL DEFAULT 'working' CHECK (kind IN ('working','article')),
 form TEXT CHECK (form IS NULL OR form IN ('feature','how-to','rule','model','overview','reference')),
 article_subject_id TEXT REFERENCES subject(id) ON DELETE RESTRICT,
 related_subject_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related_subject_ids) AND json_type(related_subject_ids)='array'),
 source_files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_files) AND json_type(source_files)='array'), checked_against_commit TEXT, summary TEXT,
 CHECK ((owner IS NOT NULL AND scope IN ('canon','settings') AND subject IS NULL) OR (owner IS NULL AND ((scope IN ('machine','global') AND subject IS NULL) OR (scope IN ('project','stack','agent','job','resume','context') AND subject IS NOT NULL) OR scope IN ('canon','settings'))))
);
INSERT INTO doc_revision SELECT * FROM doc_revision_context_scope_snapshot;
CREATE UNIQUE INDEX doc_address ON doc(scope,COALESCE(subject,''),COALESCE(owner,''),slug);
CREATE UNIQUE INDEX doc_record_id ON doc(record_id);
CREATE INDEX doc_parent_record_id ON doc(parent_record_id);
CREATE INDEX doc_project_record_id ON doc(project_record_id);
CREATE INDEX doc_scope_subject ON doc(scope,subject);
CREATE INDEX doc_article_subject_id ON doc(article_subject_id);
CREATE INDEX doc_space_id ON doc(space_id);
CREATE INDEX doc_related_subject_doc ON doc_related_subject(doc_record_id);
CREATE INDEX doc_related_subject_subject ON doc_related_subject(subject_id);
CREATE UNIQUE INDEX doc_related_subject_record_id_unique ON doc_related_subject(record_id);
CREATE INDEX doc_revision_address ON doc_revision(scope,COALESCE(subject,''),COALESCE(owner,''),slug,number);
CREATE INDEX doc_revision_doc_record_id ON doc_revision(doc_record_id,number);
CREATE INDEX doc_revision_parent_record_id ON doc_revision(parent_record_id);
CREATE INDEX doc_revision_project_record_id ON doc_revision(project_record_id);
CREATE INDEX doc_revision_article_subject_id ON doc_revision(article_subject_id);
DROP TABLE doc_context_scope_snapshot;
DROP TABLE doc_revision_context_scope_snapshot;
DROP TABLE doc_related_subject_context_scope_snapshot;
