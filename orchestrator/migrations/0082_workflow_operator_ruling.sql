ALTER TABLE workflow_obligation ADD COLUMN operator_ruling INTEGER NOT NULL DEFAULT 0
  CHECK (operator_ruling IN (0,1));
