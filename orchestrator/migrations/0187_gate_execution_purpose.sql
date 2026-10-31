ALTER TABLE gate_execution
ADD COLUMN purpose TEXT NOT NULL DEFAULT 'gate'
CHECK (purpose IN ('gate','worker-check'));
