ALTER TABLE project_lens_profile NO FORCE ROW LEVEL SECURITY;
ALTER TABLE project_lens_profile_revision NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  resolved_pins bigint;
  resolved_history bigint;
  unresolved_pins bigint;
BEGIN
  WITH resolved AS (
    SELECT selection.id,
      CASE
        WHEN selection.selected_version = profile.version THEN profile.current_version_id
        ELSE revision.id
      END AS version_id
    FROM project_lens_profile selection
    JOIN lens_profile profile
      ON profile.space_id = selection.space_id
      AND profile.lens_id = selection.lens_id
      AND profile.axis = selection.axis
      AND profile.name = selection.profile_name
    LEFT JOIN lens_profile_revision revision
      ON revision.space_id = profile.space_id
      AND revision.profile_id = profile.id
      AND revision.version = selection.selected_version
    WHERE selection.selected_version IS NOT NULL
      AND selection.lens_id IS NOT NULL
  )
  UPDATE project_lens_profile selection
  SET selected_version_id = resolved.version_id
  FROM resolved
  WHERE selection.id = resolved.id
    AND resolved.version_id IS NOT NULL;
  GET DIAGNOSTICS resolved_pins = ROW_COUNT;

  WITH resolved AS (
    SELECT history.id,
      CASE
        WHEN history.prior_selected_version = profile.version THEN profile.current_version_id
        ELSE revision.id
      END AS version_id
    FROM project_lens_profile_revision history
    JOIN project_lens_profile selection
      ON selection.space_id = history.space_id
      AND selection.id = history.selection_id
    JOIN lens_profile profile
      ON profile.space_id = history.space_id
      AND profile.lens_id = selection.lens_id
      AND profile.axis = selection.axis
      AND profile.name = history.prior_profile_name
    LEFT JOIN lens_profile_revision revision
      ON revision.space_id = profile.space_id
      AND revision.profile_id = profile.id
      AND revision.version = history.prior_selected_version
    WHERE history.prior_selected_version IS NOT NULL
      AND selection.lens_id IS NOT NULL
  )
  UPDATE project_lens_profile_revision history
  SET prior_selected_version_id = resolved.version_id
  FROM resolved
  WHERE history.id = resolved.id
    AND resolved.version_id IS NOT NULL;
  GET DIAGNOSTICS resolved_history = ROW_COUNT;

  SELECT
    (SELECT count(*) FROM project_lens_profile
      WHERE selected_version IS NOT NULL AND selected_version_id IS NULL)
    +
    (SELECT count(*) FROM project_lens_profile_revision
      WHERE prior_selected_version IS NOT NULL AND prior_selected_version_id IS NULL)
  INTO unresolved_pins;

  RAISE NOTICE 'DEV-1989 lens profile selected version ids: resolved=%, unresolved=%',
    resolved_pins + resolved_history, unresolved_pins;
END $$;
--> statement-breakpoint
ALTER TABLE project_lens_profile FORCE ROW LEVEL SECURITY;
ALTER TABLE project_lens_profile_revision FORCE ROW LEVEL SECURITY;
