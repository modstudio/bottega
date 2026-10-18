COMMENT ON COLUMN project_lens_profile.selected_version IS
  'Pinned lens profile content version; null follows the current profile version.';
COMMENT ON COLUMN project_lens_profile.selection_version IS
  'Compare-and-set version of this project profile selection; increments on every selection write.';
