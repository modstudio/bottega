-- DEV-1214: documents, revisions, and canon packs are UUID-keyed.
CREATE TABLE doc_doc_uuid_snapshot AS SELECT * FROM doc;
CREATE TABLE doc_revision_doc_uuid_snapshot AS SELECT * FROM doc_revision;
CREATE TABLE canon_pack_doc_uuid_snapshot AS SELECT * FROM canon_pack;
CREATE TABLE doc_related_subject_doc_uuid_snapshot AS SELECT * FROM doc_related_subject;
CREATE TEMP TABLE doc_revision_sequence_doc_uuid AS SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='doc_revision'),0) seq;
--> statement-breakpoint
DROP TABLE doc_revision;
DROP TABLE canon_pack;
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
 source_files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_files) AND json_type(source_files)='array'), checked_against_commit TEXT, summary TEXT,
 CHECK ((owner IS NOT NULL AND scope IN ('canon','settings') AND subject IS NULL) OR (owner IS NULL AND ((scope IN ('machine','global') AND subject IS NULL) OR (scope IN ('project','stack','agent','job','resume') AND subject IS NOT NULL) OR scope IN ('canon','settings')))),
 UNIQUE(scope,subject,slug)
);
INSERT INTO doc SELECT d.record_id,d.scope,d.subject,d.slug,d.title,d.project_record_id,d.body,d.delivery,d.created_at,d.updated_at,d.owner,d.audiences,
 (SELECT p.record_id FROM doc_doc_uuid_snapshot p WHERE p.id=d.parent_id),d.position,d.featured,d.replacement_slug,d.status,d.kind,d.form,d.article_subject_id,d.source_files,d.checked_against_commit,d.summary
FROM doc_doc_uuid_snapshot d;
--> statement-breakpoint
CREATE TABLE doc_related_subject (
 id TEXT PRIMARY KEY, doc_record_id TEXT NOT NULL REFERENCES doc(record_id) ON DELETE CASCADE,
 subject_id TEXT NOT NULL REFERENCES subject(id) ON DELETE RESTRICT, record_id TEXT NOT NULL,
 UNIQUE(doc_record_id,subject_id)
);
INSERT INTO doc_related_subject SELECT * FROM doc_related_subject_doc_uuid_snapshot;
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
INSERT INTO doc_revision SELECT r.record_id,r.id,(SELECT d.record_id FROM doc_doc_uuid_snapshot d WHERE d.id=r.doc_id),r.scope,r.subject,r.slug,r.project_record_id,r.op,r.title,r.body,r.delivery,r.author,r.reason,r.session_id,r.at,r.owner,r.audiences,
 (SELECT p.record_id FROM doc_doc_uuid_snapshot p WHERE p.id=r.parent_id),r.position,r.featured,r.replacement_slug,r.status,r.kind,r.form,r.article_subject_id,r.related_subject_ids,r.source_files,r.checked_against_commit,r.summary
FROM doc_revision_doc_uuid_snapshot r;
INSERT INTO entity_number_counter(record_id,entity,last_number)
SELECT '00000000-0000-4000-8000-000000000130','doc_revision',MAX((SELECT seq FROM doc_revision_sequence_doc_uuid),COALESCE(MAX(id),0)) FROM doc_revision_doc_uuid_snapshot;
UPDATE question SET
 filed_record_id=substr(filed_ref,instr(filed_ref,'@')+1),
 filed_ref=(SELECT r.scope||'/'||COALESCE(r.subject,'_')||'/'||r.slug||'@'||r.id
   FROM doc_revision_doc_uuid_snapshot r
   WHERE r.record_id=substr(question.filed_ref,instr(question.filed_ref,'@')+1))
WHERE filed_as='doc' AND filed_ref IS NOT NULL;
UPDATE workflow_obligation SET satisfied_evidence=(
 SELECT json_group_array(json_object('flag',json_extract(item.value,'$.flag'),'value',
  CASE WHEN json_extract(item.value,'$.flag')='--artifact' AND (
    (json_extract(item.value,'$.value') GLOB 'doc:[0-9]*' AND substr(json_extract(item.value,'$.value'),5) NOT GLOB '*[^0-9]*') OR
    (json_extract(item.value,'$.value') GLOB '[0-9]*' AND json_extract(item.value,'$.value') NOT GLOB '*[^0-9]*' AND NOT EXISTS (SELECT 1 FROM run WHERE number=CAST(json_extract(item.value,'$.value') AS INTEGER)))
  ) THEN 'doc:'||COALESCE(
    (SELECT d.scope||'/'||COALESCE(d.subject,'_')||'/'||d.slug FROM doc_doc_uuid_snapshot d WHERE d.id=CAST(CASE WHEN json_extract(item.value,'$.value') LIKE 'doc:%' THEN substr(json_extract(item.value,'$.value'),5) ELSE json_extract(item.value,'$.value') END AS INTEGER)),
    (SELECT r.scope||'/'||COALESCE(r.subject,'_')||'/'||r.slug FROM doc_revision_doc_uuid_snapshot r WHERE r.doc_id=CAST(CASE WHEN json_extract(item.value,'$.value') LIKE 'doc:%' THEN substr(json_extract(item.value,'$.value'),5) ELSE json_extract(item.value,'$.value') END AS INTEGER) ORDER BY r.id DESC LIMIT 1)
  ) ELSE json_extract(item.value,'$.value') END)) FROM json_each(workflow_obligation.satisfied_evidence) item
) WHERE satisfied_evidence IS NOT NULL;
--> statement-breakpoint
CREATE TABLE canon_pack (
 record_id TEXT NOT NULL PRIMARY KEY, job TEXT NOT NULL, project TEXT, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
 doc_count INTEGER NOT NULL, doc_revisions TEXT NOT NULL, compiled_at TEXT NOT NULL, findings INTEGER NOT NULL,
 project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT, canon_bytes INTEGER NOT NULL DEFAULT 0, doc_bytes INTEGER NOT NULL DEFAULT 0,
 UNIQUE(job,project)
);
INSERT INTO canon_pack SELECT c.record_id,c.job,c.project,c.sha256,c.bytes,c.doc_count,
 (SELECT json_group_array(json_set(item.value,'$.revisionId',(SELECT r.record_id FROM doc_revision_doc_uuid_snapshot r WHERE r.id=json_extract(item.value,'$.revisionId')))) FROM json_each(c.doc_revisions) item),
 c.compiled_at,c.findings,c.project_record_id,c.canon_bytes,c.doc_bytes FROM canon_pack_doc_uuid_snapshot c;
UPDATE run SET doc_revisions=(SELECT json_group_array((SELECT r.record_id FROM doc_revision_doc_uuid_snapshot r WHERE r.id=item.value)) FROM json_each(run.doc_revisions) item) WHERE doc_revisions IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX doc_address ON doc(scope,COALESCE(subject,''),COALESCE(owner,''),slug);
CREATE UNIQUE INDEX doc_record_id ON doc(record_id);
CREATE INDEX doc_parent_record_id ON doc(parent_record_id);
CREATE INDEX doc_project_record_id ON doc(project_record_id);
CREATE INDEX doc_scope_subject ON doc(scope,subject);
CREATE INDEX doc_article_subject_id ON doc(article_subject_id);
CREATE INDEX doc_related_subject_doc ON doc_related_subject(doc_record_id);
CREATE INDEX doc_related_subject_subject ON doc_related_subject(subject_id);
CREATE UNIQUE INDEX doc_related_subject_record_id_unique ON doc_related_subject(record_id);
CREATE INDEX doc_revision_address ON doc_revision(scope,COALESCE(subject,''),COALESCE(owner,''),slug,number);
CREATE INDEX doc_revision_doc_record_id ON doc_revision(doc_record_id,number);
CREATE INDEX doc_revision_parent_record_id ON doc_revision(parent_record_id);
CREATE INDEX doc_revision_project_record_id ON doc_revision(project_record_id);
CREATE INDEX doc_revision_article_subject_id ON doc_revision(article_subject_id);
CREATE UNIQUE INDEX canon_pack_address ON canon_pack(job,COALESCE(project,''));
CREATE INDEX canon_pack_project_record_id ON canon_pack(project_record_id);
CREATE UNIQUE INDEX canon_pack_record_id_unique ON canon_pack(record_id);
--> statement-breakpoint
DROP TABLE doc_doc_uuid_snapshot;
DROP TABLE doc_revision_doc_uuid_snapshot;
DROP TABLE canon_pack_doc_uuid_snapshot;
DROP TABLE doc_related_subject_doc_uuid_snapshot;
DROP TABLE doc_revision_sequence_doc_uuid;
