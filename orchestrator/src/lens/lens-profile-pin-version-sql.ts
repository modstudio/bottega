// concern: lens-profile-pin-version-sql
/** Defines the SQLite fragments that derive a selected profile version label from its id. */
export const LOCAL_PIN_VERSION_SQL = 'COALESCE(current_profile.version,pinned_revision.version)'

export const LOCAL_SELECTION_PIN_VERSION_JOINS_SQL = `LEFT JOIN lens_profile current_profile
      ON current_profile.space_id IS selection.space_id
      AND current_profile.lens_record_id IS selection.lens_record_id
      AND current_profile.axis=selection.axis
      AND current_profile.name=selection.profile_name
      AND current_profile.current_version_id=selection.selected_version_id
    LEFT JOIN lens_profile_revision pinned_revision
      ON pinned_revision.space_id IS selection.space_id
      AND pinned_revision.record_id=selection.selected_version_id`

export const LOCAL_REVISION_PIN_VERSION_JOINS_SQL = `LEFT JOIN lens_profile current_profile
      ON current_profile.space_id IS history.space_id
      AND current_profile.lens_record_id IS selection.lens_record_id
      AND current_profile.axis=selection.axis
      AND current_profile.name=history.prior_profile_name
      AND current_profile.current_version_id=history.prior_selected_version_id
    LEFT JOIN lens_profile_revision pinned_revision
      ON pinned_revision.space_id IS history.space_id
      AND pinned_revision.record_id=history.prior_selected_version_id`
