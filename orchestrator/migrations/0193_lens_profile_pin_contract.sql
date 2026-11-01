ALTER TABLE project_lens_profile DROP COLUMN selected_version;
ALTER TABLE project_lens_profile_revision DROP COLUMN prior_selected_version;
--> statement-breakpoint
ALTER TABLE lens_profile_revision RENAME TO lens_profile_revision_before_pin_contract;
ALTER TABLE lens_profile RENAME TO lens_profile_before_pin_contract;
--> statement-breakpoint
CREATE TABLE lens_profile (
  record_id TEXT NOT NULL PRIMARY KEY,
  lens_record_id TEXT NOT NULL REFERENCES lens(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK(axis IN ('framework','architecture')),
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  space_id TEXT,
  current_version_id TEXT NOT NULL
);
CREATE TABLE lens_profile_revision (
  record_id TEXT NOT NULL PRIMARY KEY,
  profile_record_id TEXT NOT NULL REFERENCES lens_profile(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  version INTEGER NOT NULL,
  prior_body TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  space_id TEXT
);
--> statement-breakpoint
INSERT INTO lens_profile
  (record_id,lens_record_id,axis,name,version,body,enabled,space_id,current_version_id)
SELECT record_id,lens_record_id,axis,name,version,body,enabled,space_id,current_version_id
FROM lens_profile_before_pin_contract;
INSERT INTO lens_profile_revision
  (record_id,profile_record_id,version,prior_body,reason,session_id,at,space_id)
SELECT record_id,profile_record_id,version,prior_body,reason,session_id,at,space_id
FROM lens_profile_revision_before_pin_contract;
DROP TABLE lens_profile_revision_before_pin_contract;
DROP TABLE lens_profile_before_pin_contract;
--> statement-breakpoint
CREATE INDEX lens_profile_lens_record_id ON lens_profile(lens_record_id,axis,name);
CREATE UNIQUE INDEX lens_profile_local_key ON lens_profile(lens_record_id,axis,name) WHERE space_id IS NULL;
CREATE UNIQUE INDEX lens_profile_hosted_key ON lens_profile(space_id,lens_record_id,axis,name) WHERE space_id IS NOT NULL;
CREATE INDEX lens_profile_space_lens_record_id ON lens_profile(space_id,lens_record_id,axis,name);
CREATE INDEX lens_profile_revision_profile_record_id ON lens_profile_revision(profile_record_id,version);
CREATE UNIQUE INDEX lens_profile_revision_local_version ON lens_profile_revision(profile_record_id,version) WHERE space_id IS NULL;
CREATE UNIQUE INDEX lens_profile_revision_hosted_version ON lens_profile_revision(space_id,profile_record_id,version) WHERE space_id IS NOT NULL;
