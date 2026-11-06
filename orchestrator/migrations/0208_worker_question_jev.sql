ALTER TABLE question ADD COLUMN kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('choice','yesno','score','text'));
ALTER TABLE question ADD COLUMN typed_options TEXT;
ALTER TABLE question ADD COLUMN criteria TEXT;
ALTER TABLE question ADD COLUMN levels TEXT;
ALTER TABLE question ADD COLUMN answer_value TEXT;
ALTER TABLE question ADD COLUMN answered_by_kind TEXT CHECK (answered_by_kind IN ('architect','jev'));
ALTER TABLE question ADD COLUMN jev_pick TEXT;
ALTER TABLE question ADD COLUMN jev_confidence REAL;
ALTER TABLE question ADD COLUMN jev_probabilities TEXT;
ALTER TABLE question ADD COLUMN jev_model TEXT;
ALTER TABLE question ADD COLUMN jev_input_tokens INTEGER;
ALTER TABLE question ADD COLUMN jev_error TEXT;
ALTER TABLE question ADD COLUMN jev_agreed INTEGER CHECK (jev_agreed IN (0,1));

-- BACKFILL
UPDATE question
SET kind='choice'
WHERE options IS NOT NULL
  AND json_valid(options)
  AND json_type(options)='array'
  AND json_array_length(options)>0;
-- /BACKFILL
