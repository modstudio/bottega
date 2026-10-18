ALTER TABLE project_lens_profile
  ADD COLUMN selection_version INTEGER NOT NULL DEFAULT 1 CHECK(selection_version > 0);
