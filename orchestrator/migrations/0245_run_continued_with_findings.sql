ALTER TABLE run ADD COLUMN continued_with_findings INTEGER NOT NULL DEFAULT 0 CHECK (continued_with_findings IN (0,1));
