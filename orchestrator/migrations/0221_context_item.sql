-- DEV-2293: context items leave the document store.
CREATE TABLE context_item (
 id TEXT NOT NULL PRIMARY KEY,
 holder_kind TEXT NOT NULL CHECK (holder_kind IN ('task','session','cursor')),
 holder_id TEXT NOT NULL,
 slug TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('ruling','position','fact','pointer','next-action','open-question')),
 body TEXT NOT NULL,
 source TEXT NOT NULL,
 question_number INTEGER,
 target TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(holder_kind,holder_id,slug)
);
WITH positions AS (
 SELECT *,
   instr(body,char(10)||'kind: ')+7 kind_start,
   instr(body,char(10)||'source: ')+9 source_start,
   CASE WHEN instr(body,char(10)||'objection: ') > 0 THEN instr(body,char(10)||'objection: ')+12 ELSE 0 END objection_start,
   instr(substr(body,5),char(10)||'---')+4 close_at
 FROM doc WHERE scope='context'
), parsed AS (
 SELECT *,
   json_extract(substr(body,kind_start,instr(substr(body,kind_start),char(10))-1),'$') context_kind,
   json_extract(substr(body,source_start,instr(substr(body,source_start),char(10))-1),'$') context_source,
   CASE WHEN objection_start > 0 THEN json_extract(substr(body,objection_start,instr(substr(body,objection_start),char(10))-1),'$') END objection,
   substr(body,close_at+5) context_body
 FROM positions
)
INSERT INTO context_item(id,holder_kind,holder_id,slug,kind,body,source,question_number,target,created_at,updated_at)
SELECT record_id,
 substr(subject,1,instr(subject,':')-1), substr(subject,instr(subject,':')+1), slug, context_kind,
 context_body || CASE WHEN objection IS NULL THEN '' ELSE char(10)||char(10)||'Overrode: '||objection END,
 context_source,
 CASE WHEN context_kind IN ('ruling','position') AND context_source GLOB 'q[0-9]*' THEN CAST(substr(context_source,2) AS INTEGER) END,
 CASE WHEN context_kind='pointer' THEN trim(context_body) END,
 created_at,updated_at
FROM parsed
WHERE true
ON CONFLICT(holder_kind,holder_id,slug) DO NOTHING;
DELETE FROM doc_revision WHERE scope='context';
DELETE FROM doc_related_subject WHERE doc_record_id IN (SELECT record_id FROM doc WHERE scope='context');
DELETE FROM doc WHERE scope='context';
--> statement-breakpoint
CREATE TABLE doc_context_contract_snapshot AS SELECT * FROM doc;
CREATE TABLE doc_revision_context_contract_snapshot AS SELECT * FROM doc_revision;
CREATE TABLE doc_related_subject_context_contract_snapshot AS SELECT * FROM doc_related_subject;
DROP TABLE doc_revision;
DROP TABLE doc_related_subject;
DROP TABLE doc;
--> statement-breakpoint
CREATE TABLE doc (
 record_id TEXT NOT NULL PRIMARY KEY,
 scope TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','stack','resume','canon','settings')),
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
 CHECK ((owner IS NOT NULL AND scope IN ('canon','settings') AND subject IS NULL) OR (owner IS NULL AND ((scope IN ('machine','global') AND subject IS NULL) OR (scope IN ('project','stack','agent','job','resume') AND subject IS NOT NULL) OR scope IN ('canon','settings')))),
 UNIQUE(scope,subject,slug)
);
INSERT INTO doc SELECT * FROM doc_context_contract_snapshot;
CREATE TABLE doc_related_subject (
 record_id TEXT NOT NULL PRIMARY KEY, doc_record_id TEXT NOT NULL REFERENCES doc(record_id) ON DELETE CASCADE,
 subject_id TEXT NOT NULL REFERENCES subject(id) ON DELETE RESTRICT,
 UNIQUE(doc_record_id,subject_id)
);
INSERT INTO doc_related_subject SELECT * FROM doc_related_subject_context_contract_snapshot;
CREATE TABLE doc_revision (
 record_id TEXT NOT NULL PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
 doc_record_id TEXT REFERENCES doc(record_id) ON DELETE SET NULL,
 scope TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','stack','resume','canon','settings')),
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
 CHECK ((owner IS NOT NULL AND scope IN ('canon','settings') AND subject IS NULL) OR (owner IS NULL AND ((scope IN ('machine','global') AND subject IS NULL) OR (scope IN ('project','stack','agent','job','resume') AND subject IS NOT NULL) OR scope IN ('canon','settings'))))
);
INSERT INTO doc_revision SELECT * FROM doc_revision_context_contract_snapshot;
CREATE UNIQUE INDEX doc_address ON doc(scope,COALESCE(subject,''),COALESCE(owner,''),slug);
CREATE UNIQUE INDEX doc_record_id ON doc(record_id);
CREATE INDEX doc_parent_record_id ON doc(parent_record_id);
CREATE INDEX doc_project_record_id ON doc(project_record_id);
CREATE INDEX doc_scope_subject ON doc(scope,subject);
CREATE INDEX doc_article_subject_id ON doc(article_subject_id);
CREATE INDEX doc_space_id ON doc(space_id);
CREATE INDEX doc_related_subject_doc ON doc_related_subject(doc_record_id);
CREATE INDEX doc_related_subject_subject ON doc_related_subject(subject_id);
CREATE INDEX doc_revision_address ON doc_revision(scope,COALESCE(subject,''),COALESCE(owner,''),slug,number);
CREATE INDEX doc_revision_doc_record_id ON doc_revision(doc_record_id,number);
CREATE INDEX doc_revision_parent_record_id ON doc_revision(parent_record_id);
CREATE INDEX doc_revision_project_record_id ON doc_revision(project_record_id);
CREATE INDEX doc_revision_article_subject_id ON doc_revision(article_subject_id);
CREATE INDEX context_item_holder ON context_item(holder_kind,holder_id);
DROP TABLE doc_context_contract_snapshot;
DROP TABLE doc_revision_context_contract_snapshot;
DROP TABLE doc_related_subject_context_contract_snapshot;
