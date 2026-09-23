ALTER TABLE lens ADD COLUMN requires_execution INTEGER NOT NULL DEFAULT 0 CHECK(requires_execution IN (0,1));
