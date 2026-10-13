ALTER TABLE board_message ADD COLUMN purpose TEXT
  CHECK (purpose IS NULL OR purpose IN ('information','request','standing'));
UPDATE board_message SET purpose='information' WHERE kind<>'reply';

ALTER TABLE board_reach_delivery ADD COLUMN purpose TEXT NOT NULL DEFAULT 'information'
  CHECK (purpose IN ('information','request','standing'));
