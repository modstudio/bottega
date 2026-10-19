CREATE TABLE review_review_uuid (
  record_id TEXT NOT NULL PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL, completed_at TEXT, tier INTEGER, tier_risk INTEGER,
  tier_size INTEGER, tier_reasons TEXT, tier_reason TEXT,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  patch_id TEXT, path_set TEXT, commit_message TEXT, outdated_at TEXT, outdated_reason TEXT
);
INSERT INTO review_review_uuid SELECT record_id,id,recorded_at,completed_at,tier,tier_risk,tier_size,
 tier_reasons,tier_reason,project_record_id,patch_id,path_set,commit_message,outdated_at,outdated_reason
FROM review ORDER BY id;
INSERT INTO entity_number_counter(record_id,entity,last_number)
SELECT '00000000-0000-4000-8000-000000000126','review',
 MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='review'),0),COALESCE(MAX(id),0)) FROM review;
--> statement-breakpoint
CREATE TABLE review_lens_review_uuid_snapshot AS SELECT * FROM review_lens;
CREATE TABLE review_finding_review_uuid_snapshot AS SELECT * FROM review_finding;
CREATE TABLE review_read_review_uuid_snapshot AS SELECT * FROM review_read;
CREATE TABLE review_finding_amendment_review_uuid_snapshot AS SELECT * FROM review_finding_amendment;
CREATE TABLE landing_review_uuid_snapshot AS SELECT * FROM landing;
CREATE TABLE landing_override_review_uuid_snapshot AS SELECT * FROM landing_override;
CREATE TABLE landing_review_carry_review_uuid_snapshot AS SELECT * FROM landing_review_carry;
CREATE TABLE landing_triage_snapshot_review_uuid_snapshot AS SELECT * FROM landing_triage_snapshot;
CREATE TABLE contention_review_uuid_snapshot AS SELECT * FROM contention;
CREATE TABLE test_flake_review_uuid_snapshot AS SELECT * FROM test_flake;
DROP TABLE review_finding;
DROP TABLE review_lens;
DROP TABLE review_finding_amendment;
DROP TABLE landing_review_carry;
DROP TABLE landing_triage_snapshot;
DROP TABLE contention;
DROP TABLE test_flake;
DROP TABLE review_read;
DROP TABLE landing_override;
DROP TABLE landing;
DROP TABLE review;
ALTER TABLE review_review_uuid RENAME TO review;
--> statement-breakpoint
CREATE TABLE review_lens_review_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  review_record_id TEXT NOT NULL REFERENCES review(record_id) ON DELETE CASCADE,
  run_record_id TEXT NOT NULL UNIQUE REFERENCES run(record_id) ON DELETE CASCADE,
  lens TEXT NOT NULL, agent TEXT NOT NULL, model TEXT, tree_inspected TEXT, reviewed_tree TEXT,
  standards_read TEXT NOT NULL, files_covered TEXT NOT NULL, commands_run TEXT NOT NULL,
  could_not_verify TEXT NOT NULL,
  reproduced TEXT CHECK (reproduced IS NULL OR reproduced IN ('none','some','all')),
  coverage TEXT CHECK (coverage IS NULL OR coverage IN ('empty','partial','adequate')),
  limits TEXT CHECK (limits IS NULL OR limits IN ('named','absent')),
  overlap TEXT CHECK (overlap IS NULL OR overlap IN ('unique','shared','none','alone')),
  mcp_tools TEXT NOT NULL DEFAULT '[]', docs_read TEXT NOT NULL DEFAULT '[]',
  substitutes TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO review_lens_review_uuid SELECT l.record_id,
 (SELECT r.record_id FROM review r WHERE r.number=l.review_id),l.run_record_id,l.lens,l.agent,l.model,
 l.tree_inspected,l.reviewed_tree,l.standards_read,l.files_covered,l.commands_run,l.could_not_verify,
 l.reproduced,l.coverage,l.limits,l.overlap,l.mcp_tools,l.docs_read,l.substitutes
FROM review_lens_review_uuid_snapshot l;
ALTER TABLE review_lens_review_uuid RENAME TO review_lens;
CREATE TABLE review_finding_review_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  review_record_id TEXT NOT NULL REFERENCES review(record_id) ON DELETE CASCADE,
  review_lens_record_id TEXT NOT NULL REFERENCES review_lens(record_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, severity TEXT NOT NULL, location TEXT NOT NULL, evidence TEXT NOT NULL,
  proposed_correction TEXT NOT NULL,
  disposition TEXT CHECK (disposition IS NULL OR disposition IN ('accepted','modified','rejected','skipped')),
  rejection_category TEXT,
  triaged_severity TEXT CHECK (triaged_severity IS NULL OR triaged_severity IN ('critical','high','medium','low')),
  triaged_at TEXT, UNIQUE(review_record_id,ordinal),
  CHECK (disposition = 'rejected' OR rejection_category IS NULL)
);
INSERT INTO review_finding_review_uuid SELECT f.record_id,
 (SELECT r.record_id FROM review r WHERE r.number=f.review_id),
 (SELECT old.record_id FROM review_lens_review_uuid_snapshot old WHERE old.id=f.review_lens_id),
 f.ordinal,f.severity,f.location,f.evidence,f.proposed_correction,f.disposition,f.rejection_category,
 f.triaged_severity,f.triaged_at FROM review_finding_review_uuid_snapshot f;
DROP TABLE review_finding_review_uuid_snapshot;
DROP TABLE review_lens_review_uuid_snapshot;
ALTER TABLE review_finding_review_uuid RENAME TO review_finding;
CREATE TABLE review_read_review_uuid (
  record_id TEXT NOT NULL PRIMARY KEY, project TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  branch TEXT NOT NULL, tip TEXT NOT NULL, patch_id TEXT NOT NULL,
  path_set TEXT NOT NULL CHECK (json_valid(path_set)), tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  note TEXT NOT NULL CHECK (length(trim(note)) > 0), session_id TEXT, recorded_at TEXT NOT NULL
);
INSERT INTO review_read_review_uuid SELECT record_id,project,project_record_id,branch,tip,patch_id,path_set,
 tier,note,session_id,recorded_at FROM review_read_review_uuid_snapshot;
ALTER TABLE review_read_review_uuid RENAME TO review_read;
CREATE TABLE review_finding_amendment_review_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  review_finding_record_id TEXT NOT NULL REFERENCES review_finding(record_id),
  old_disposition TEXT CHECK (old_disposition IN ('accepted','modified','rejected','skipped')),
  new_disposition TEXT NOT NULL CHECK (new_disposition IN ('accepted','modified','rejected','skipped')),
  old_rejection_category TEXT, new_rejection_category TEXT,
  old_triaged_severity TEXT CHECK (old_triaged_severity IN ('critical','high','medium','low')),
  new_triaged_severity TEXT CHECK (new_triaged_severity IN ('critical','high','medium','low')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_session TEXT CHECK (actor_session IS NULL OR length(actor_session) > 0), at TEXT NOT NULL
);
INSERT INTO review_finding_amendment_review_uuid SELECT a.record_id,
 (SELECT f.record_id FROM review_finding f JOIN review r ON r.record_id=f.review_record_id
   WHERE r.number=a.review_id AND f.ordinal=a.finding_ordinal),a.old_disposition,
 a.new_disposition,a.old_rejection_category,a.new_rejection_category,a.old_triaged_severity,
 a.new_triaged_severity,a.reason,a.actor_session,a.at FROM review_finding_amendment_review_uuid_snapshot a;
DROP TABLE review_finding_amendment_review_uuid_snapshot;
ALTER TABLE review_finding_amendment_review_uuid RENAME TO review_finding_amendment;
--> statement-breakpoint
CREATE TABLE landing_review_uuid (
  record_id TEXT NOT NULL PRIMARY KEY, project TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  branch TEXT NOT NULL, tip TEXT, trunk_before TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','landed','refused','install_failed','rebase_required')),
  error TEXT, session_id TEXT, started_at TEXT NOT NULL, finished_at TEXT,
  path_set TEXT CHECK (path_set IS NULL OR json_valid(path_set)), requested_at TEXT,
  steps TEXT CHECK (steps IS NULL OR json_valid(steps)),
  causing_landing_record_id TEXT REFERENCES landing_review_uuid(record_id),
  claim_pid INTEGER, claim_session TEXT, heartbeat_delivered_at TEXT
);
INSERT INTO landing_review_uuid SELECT l.record_id,l.project,l.project_record_id,l.branch,l.tip,l.trunk_before,
 l.status,l.error,l.session_id,l.started_at,l.finished_at,l.path_set,l.requested_at,l.steps,
 (SELECT parent.record_id FROM landing_review_uuid_snapshot parent WHERE parent.id=l.causing_landing_id),
 l.claim_pid,l.claim_session,l.heartbeat_delivered_at FROM landing_review_uuid_snapshot l;
CREATE TABLE landing_override_review_uuid (
  record_id TEXT NOT NULL PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, tip TEXT NOT NULL,
  tree TEXT NOT NULL, reason TEXT NOT NULL CHECK (length(trim(reason)) > 0), session_id TEXT, at TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  patch_id TEXT, path_set TEXT CHECK (path_set IS NULL OR json_valid(path_set))
);
INSERT INTO landing_override_review_uuid SELECT record_id,project,branch,tip,tree,reason,session_id,at,
 project_record_id,patch_id,path_set FROM landing_override_review_uuid_snapshot;
CREATE TABLE landing_review_carry_review_uuid (
  record_id TEXT NOT NULL PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, tip TEXT NOT NULL,
  tree TEXT NOT NULL, review_record_id TEXT NOT NULL REFERENCES review(record_id),
  reviewed_commit TEXT NOT NULL, reviewed_tree TEXT NOT NULL, patch_id TEXT NOT NULL,
  old_base TEXT NOT NULL, new_base TEXT NOT NULL, session_id TEXT, at TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT
);
INSERT INTO landing_review_carry_review_uuid SELECT c.record_id,c.project,c.branch,c.tip,c.tree,
 (SELECT r.record_id FROM review r WHERE r.number=c.review_id),c.reviewed_commit,c.reviewed_tree,
 c.patch_id,c.old_base,c.new_base,c.session_id,c.at,c.project_record_id
FROM landing_review_carry_review_uuid_snapshot c;
CREATE TABLE landing_triage_snapshot_review_uuid (
  record_id TEXT NOT NULL PRIMARY KEY, project TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  branch TEXT NOT NULL, tip TEXT NOT NULL, tree TEXT NOT NULL, pr_number INTEGER CHECK (pr_number > 0),
  review_record_ids TEXT NOT NULL CHECK (json_valid(review_record_ids) AND json_type(review_record_ids)='array'),
  patch_id TEXT NOT NULL, tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  lens_rounds INTEGER NOT NULL CHECK (lens_rounds >= 0), finding_count INTEGER NOT NULL CHECK (finding_count >= 0),
  override_record_id TEXT REFERENCES landing_override_review_uuid(record_id), session_id TEXT, at TEXT NOT NULL,
  admission_path TEXT NOT NULL DEFAULT 'exact_review' CHECK (admission_path IN ('exact_review','architect_read')),
  read_record_id TEXT REFERENCES review_read(record_id), UNIQUE(project,branch,tip)
);
INSERT INTO landing_triage_snapshot_review_uuid SELECT s.record_id,s.project,s.project_record_id,s.branch,
 s.tip,s.tree,s.pr_number,(SELECT json_group_array(record_id) FROM
   (SELECT (SELECT r.record_id FROM review r WHERE r.number=j.value) record_id
    FROM json_each(s.review_ids) j ORDER BY CAST(j.key AS INTEGER))),
 s.patch_id,s.tier,s.lens_rounds,s.finding_count,
 (SELECT o.record_id FROM landing_override_review_uuid_snapshot o WHERE o.id=s.override_id),
 s.session_id,s.at,s.admission_path,
 (SELECT rr.record_id FROM review_read_review_uuid_snapshot rr WHERE rr.id=s.read_id)
FROM landing_triage_snapshot_review_uuid_snapshot s;
CREATE TABLE contention_review_uuid (
  record_id TEXT NOT NULL PRIMARY KEY, at TEXT NOT NULL, session_id TEXT,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('trunk','main_checkout','store','cpu','vendor','review','register','lock')),
  resource_key TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('wait','refusal','invalidation','retry','timeout')),
  duration_ms INTEGER, cause TEXT, run_record_id TEXT REFERENCES run(record_id),
  landing_record_id TEXT REFERENCES landing_review_uuid(record_id)
);
INSERT INTO contention_review_uuid SELECT c.record_id,c.at,c.session_id,c.resource_kind,c.resource_key,
 c.event_kind,c.duration_ms,c.cause,c.run_record_id,
 (SELECT l.record_id FROM landing_review_uuid_snapshot l WHERE l.id=c.landing_id)
FROM contention_review_uuid_snapshot c;
CREATE TABLE test_flake_review_uuid (
  record_id TEXT NOT NULL PRIMARY KEY, test TEXT NOT NULL, file TEXT NOT NULL,
  load_at_failure TEXT NOT NULL, signal TEXT, at TEXT NOT NULL, CHECK (json_valid(load_at_failure))
);
INSERT INTO test_flake_review_uuid SELECT record_id,test,file,load_at_failure,signal,at FROM test_flake_review_uuid_snapshot;
DROP TABLE landing_triage_snapshot_review_uuid_snapshot;
DROP TABLE review_read_review_uuid_snapshot;
DROP TABLE landing_review_carry_review_uuid_snapshot;
DROP TABLE contention_review_uuid_snapshot;
DROP TABLE test_flake_review_uuid_snapshot;
DROP TABLE landing_override_review_uuid_snapshot;
DROP TABLE landing_review_uuid_snapshot;
ALTER TABLE landing_review_uuid RENAME TO landing;
ALTER TABLE landing_override_review_uuid RENAME TO landing_override;
ALTER TABLE landing_review_carry_review_uuid RENAME TO landing_review_carry;
ALTER TABLE landing_triage_snapshot_review_uuid RENAME TO landing_triage_snapshot;
ALTER TABLE contention_review_uuid RENAME TO contention;
ALTER TABLE test_flake_review_uuid RENAME TO test_flake;
--> statement-breakpoint
CREATE INDEX review_project_id ON review(project_record_id);
CREATE INDEX review_lens_review ON review_lens(review_record_id);
CREATE INDEX review_lens_run ON review_lens(run_record_id);
CREATE INDEX review_calibration ON review_lens(lens,agent,model,review_record_id);
CREATE INDEX review_finding_review ON review_finding(review_record_id);
CREATE INDEX review_finding_lens ON review_finding(review_lens_record_id);
CREATE INDEX review_finding_amendment_finding ON review_finding_amendment(review_finding_record_id,at);
CREATE INDEX review_read_change_group ON review_read(project,branch,patch_id,path_set);
CREATE INDEX review_read_project_id ON review_read(project_record_id);
CREATE INDEX landing_project_started ON landing(project,started_at);
CREATE INDEX landing_project_id ON landing(project_record_id);
CREATE INDEX landing_project_status ON landing(project,status);
CREATE INDEX landing_cause ON landing(causing_landing_record_id);
CREATE INDEX landing_override_project_id ON landing_override(project_record_id);
CREATE INDEX landing_review_carry_project_id ON landing_review_carry(project_record_id);
CREATE INDEX landing_review_carry_review ON landing_review_carry(review_record_id);
CREATE INDEX landing_triage_snapshot_project_id ON landing_triage_snapshot(project_record_id);
CREATE INDEX landing_triage_snapshot_pr ON landing_triage_snapshot(project,pr_number);
CREATE INDEX landing_triage_snapshot_override ON landing_triage_snapshot(override_record_id);
CREATE INDEX landing_triage_snapshot_read ON landing_triage_snapshot(read_record_id);
CREATE INDEX contention_kind_at ON contention(resource_kind,at);
CREATE INDEX contention_session_at ON contention(session_id,at);
CREATE INDEX contention_run ON contention(run_record_id);
CREATE INDEX contention_landing ON contention(landing_record_id);
CREATE INDEX test_flake_test_file_at ON test_flake(test,file,at);
-- BACKFILL
UPDATE run SET project_record_id=(SELECT record_id FROM project WHERE name=run.repo)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=run.repo)=1;
UPDATE run SET project_record_id=(SELECT record_id FROM project WHERE name='bottega')
WHERE repo IN ('devbox','devbox-ops') AND project_record_id IS NULL;
UPDATE canon_pack SET project_record_id=(SELECT record_id FROM project WHERE name=canon_pack.project)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=canon_pack.project)=1;
UPDATE landing SET project_record_id=(SELECT record_id FROM project WHERE name=landing.project)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=landing.project)=1;
UPDATE landing_override SET project_record_id=(SELECT record_id FROM project WHERE name=landing_override.project)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=landing_override.project)=1;
UPDATE landing_review_carry SET project_record_id=(SELECT record_id FROM project WHERE name=landing_review_carry.project)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=landing_review_carry.project)=1;
UPDATE landing_triage_snapshot SET project_record_id=(SELECT record_id FROM project WHERE name=landing_triage_snapshot.project)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=landing_triage_snapshot.project)=1;
UPDATE review_read SET project_record_id=(SELECT record_id FROM project WHERE name=review_read.project)
WHERE project_record_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=review_read.project)=1;
UPDATE doc SET project_record_id=(SELECT record_id FROM project WHERE name=doc.subject)
WHERE project_record_id IS NULL AND scope IN ('project','resume','canon','settings')
  AND (SELECT COUNT(*) FROM project WHERE name=doc.subject)=1;
UPDATE doc_revision SET project_record_id=(SELECT record_id FROM project WHERE name=doc_revision.subject)
WHERE project_record_id IS NULL AND scope IN ('project','resume','canon','settings')
  AND (SELECT COUNT(*) FROM project WHERE name=doc_revision.subject)=1;
UPDATE review SET project_record_id=(
  SELECT MIN(r.project_record_id)
  FROM review_lens rl JOIN run r ON r.record_id=rl.run_record_id
  WHERE rl.review_record_id=review.record_id
) WHERE project_record_id IS NULL
    AND EXISTS (
      SELECT 1 FROM review_lens rl JOIN run r ON r.record_id=rl.run_record_id
      WHERE rl.review_record_id=review.record_id AND r.project_record_id IS NOT NULL
    )
    AND 1=(
      SELECT COUNT(DISTINCT r.project_record_id)
      FROM review_lens rl JOIN run r ON r.record_id=rl.run_record_id
      WHERE rl.review_record_id=review.record_id AND r.project_record_id IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM review_lens rl JOIN run r ON r.record_id=rl.run_record_id
      WHERE rl.review_record_id=review.record_id AND r.project_record_id IS NULL
    );
-- /BACKFILL
