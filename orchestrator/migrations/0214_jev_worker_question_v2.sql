ALTER TABLE question ADD COLUMN jev_question_version INTEGER;
ALTER TABLE question ADD COLUMN jev_fits REAL;
ALTER TABLE question ADD COLUMN jev_order_flipped INTEGER CHECK (jev_order_flipped IN (0,1));
