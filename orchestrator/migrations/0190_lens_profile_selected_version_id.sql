ALTER TABLE project_lens_profile ADD COLUMN selected_version_id TEXT;
ALTER TABLE project_lens_profile_revision ADD COLUMN prior_selected_version_id TEXT;
--> statement-breakpoint
-- BACKFILL
UPDATE project_lens_profile AS selection
SET selected_version_id = CASE
  WHEN selection.lens_record_id IS NULL THEN NULL
  WHEN selection.selected_version = profile.version THEN profile.current_version_id
  ELSE (
    SELECT revision.record_id
    FROM lens_profile_revision AS revision
    WHERE revision.profile_record_id = profile.record_id
      AND revision.version = selection.selected_version
      AND revision.space_id IS selection.space_id
  )
END
FROM lens_profile AS profile
WHERE selection.selected_version IS NOT NULL
  AND profile.lens_record_id = selection.lens_record_id
  AND profile.axis = selection.axis
  AND profile.name = selection.profile_name
  AND profile.space_id IS selection.space_id;

UPDATE project_lens_profile_revision AS history
SET prior_selected_version_id = CASE
  WHEN selection.lens_record_id IS NULL THEN NULL
  WHEN history.prior_selected_version = profile.version THEN profile.current_version_id
  ELSE (
    SELECT revision.record_id
    FROM lens_profile_revision AS revision
    WHERE revision.profile_record_id = profile.record_id
      AND revision.version = history.prior_selected_version
      AND revision.space_id IS history.space_id
  )
END
FROM project_lens_profile AS selection, lens_profile AS profile
WHERE history.prior_selected_version IS NOT NULL
  AND selection.record_id = history.selection_record_id
  AND selection.space_id IS history.space_id
  AND profile.lens_record_id = selection.lens_record_id
  AND profile.axis = selection.axis
  AND profile.name = history.prior_profile_name
  AND profile.space_id IS history.space_id;
-- /BACKFILL
