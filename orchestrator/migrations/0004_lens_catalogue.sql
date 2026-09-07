-- Project names were formerly join keys. Keep the text mirrors for one release,
-- but make the registered project row the referent everywhere.
ALTER TABLE run ADD COLUMN project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE canon_pack ADD COLUMN project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE landing ADD COLUMN project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE landing_override ADD COLUMN project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE landing_review_carry ADD COLUMN project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE doc ADD COLUMN project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE doc_revision ADD COLUMN project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE review ADD COLUMN project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT;
--> statement-breakpoint

UPDATE run SET project_id=(SELECT id FROM project WHERE name=run.repo) WHERE repo IS NOT NULL;
--> statement-breakpoint
-- The live store contains 77 `devbox` run rows from before this repository's
-- rename and one `devbox-ops` row for its ops concern. Both are this project.
UPDATE run SET project_id=(SELECT id FROM project WHERE name='bottega')
 WHERE repo IN ('devbox','devbox-ops') AND project_id IS NULL;
--> statement-breakpoint
UPDATE canon_pack SET project_id=(SELECT id FROM project WHERE name=canon_pack.project) WHERE project IS NOT NULL;
--> statement-breakpoint
UPDATE landing SET project_id=(SELECT id FROM project WHERE name=landing.project);
--> statement-breakpoint
UPDATE landing_override SET project_id=(SELECT id FROM project WHERE name=landing_override.project);
--> statement-breakpoint
UPDATE landing_review_carry SET project_id=(SELECT id FROM project WHERE name=landing_review_carry.project);
--> statement-breakpoint
UPDATE doc SET project_id=(SELECT id FROM project WHERE name=doc.subject) WHERE scope='project';
--> statement-breakpoint
UPDATE doc_revision SET project_id=(SELECT id FROM project WHERE name=doc_revision.subject) WHERE scope='project';
--> statement-breakpoint
UPDATE review SET project_id=(
  SELECT MIN(r.project_id) FROM review_lens rl JOIN run r ON r.id=rl.run_id
   WHERE rl.review_id=review.id
) WHERE EXISTS (SELECT 1 FROM review_lens rl JOIN run r ON r.id=rl.run_id
                 WHERE rl.review_id=review.id AND r.project_id IS NOT NULL)
    AND 1=(SELECT COUNT(DISTINCT r.project_id) FROM review_lens rl JOIN run r ON r.id=rl.run_id
            WHERE rl.review_id=review.id AND r.project_id IS NOT NULL)
    AND 0=(SELECT COUNT(*) FROM review_lens rl JOIN run r ON r.id=rl.run_id
            WHERE rl.review_id=review.id AND r.project_id IS NULL);
--> statement-breakpoint

CREATE INDEX run_project_id ON run(project_id);
--> statement-breakpoint
CREATE INDEX canon_pack_project_id ON canon_pack(project_id);
--> statement-breakpoint
CREATE INDEX landing_project_id ON landing(project_id);
--> statement-breakpoint
CREATE INDEX landing_override_project_id ON landing_override(project_id);
--> statement-breakpoint
CREATE INDEX landing_review_carry_project_id ON landing_review_carry(project_id);
--> statement-breakpoint
CREATE INDEX doc_project_id ON doc(project_id);
--> statement-breakpoint
CREATE INDEX doc_revision_project_id ON doc_revision(project_id);
--> statement-breakpoint
CREATE INDEX review_project_id ON review(project_id);
--> statement-breakpoint

CREATE TABLE lens (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  excludes TEXT NOT NULL,
  slots TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
--> statement-breakpoint
CREATE TABLE lens_revision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lens_id TEXT NOT NULL REFERENCES lens(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  prior_body TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  UNIQUE(lens_id, version)
);
--> statement-breakpoint
CREATE TABLE lens_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lens_id TEXT NOT NULL REFERENCES lens(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK(axis IN ('framework','architecture')),
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  UNIQUE(lens_id, axis, name)
);
--> statement-breakpoint
CREATE TABLE lens_profile_revision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES lens_profile(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  prior_body TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  UNIQUE(profile_id, version)
);
--> statement-breakpoint
CREATE TABLE project_lens_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  lens_id TEXT REFERENCES lens(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK(axis IN ('framework','architecture')),
  profile_name TEXT NOT NULL,
  selected_version INTEGER CHECK(selected_version IS NULL OR selected_version > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_lens_profile_specific
  ON project_lens_profile(project_id,lens_id,axis) WHERE lens_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX project_lens_profile_global
  ON project_lens_profile(project_id,axis) WHERE lens_id IS NULL;
--> statement-breakpoint
CREATE TABLE project_lens_profile_revision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  selection_id INTEGER NOT NULL REFERENCES project_lens_profile(id) ON DELETE CASCADE,
  prior_profile_name TEXT,
  prior_selected_version INTEGER CHECK(prior_selected_version IS NULL OR prior_selected_version > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL
);
--> statement-breakpoint

INSERT INTO lens (id,title,question,excludes,slots,version,enabled) VALUES
 ('correctness','Correctness','Does the change do what the spec says on every path, including failure paths?','style and naming, performance, migration safety, security','{"type":"object","properties":{"framework_guidance":{"type":"string"},"commands":{"type":"string"}},"additionalProperties":false}',1,1),
 ('migration-safety','Migration safety','Can this schema change apply to the live store and roll forward without loss, and does adoption still match afterwards?','application logic, style','{"type":"object","properties":{"framework_guidance":{"type":"string"},"commands":{"type":"string"}},"additionalProperties":false}',1,1),
 ('craft','Craft','Is the new module shaped so the next reader and the next change find one definition of each thing?','behavioural correctness, security','{"type":"object","properties":{"framework_guidance":{"type":"string"},"commands":{"type":"string"}},"additionalProperties":false}',1,1),
 ('issue-blast-radius','Issue blast radius','What else does this change reach, and what breaks when it is wrong?','whether the change itself is correct','{"type":"object","properties":{"framework_guidance":{"type":"string"},"commands":{"type":"string"}},"additionalProperties":false}',1,1),
 ('teardown-safety','Teardown safety','Can every path in worktree teardown remove only what this run owns and nothing else?','creation and landing','{"type":"object","properties":{"framework_guidance":{"type":"string"},"commands":{"type":"string"}},"additionalProperties":false}',1,1),
 ('safety','Safety','Can this change be used to damage a checkout, a store, a secret, or another session run?','correctness','{"type":"object","properties":{"framework_guidance":{"type":"string"},"commands":{"type":"string"}},"additionalProperties":false}',1,1);
--> statement-breakpoint
INSERT INTO lens_profile (lens_id,axis,name,version,body,enabled)
 SELECT id,'framework','default',1,'{"framework_guidance":"No framework-specific guidance for this stack.","commands":"None."}',1 FROM lens;
