ALTER TABLE probe ADD COLUMN command_withheld INTEGER NOT NULL DEFAULT 0
  CHECK (command_withheld IN (0,1));
--> statement-breakpoint
-- BACKFILL
UPDATE probe
SET command_withheld=CASE
      WHEN command='[withheld: secret-shaped content]' THEN 1
      ELSE command_withheld
    END,
    withheld=CASE
      WHEN output_tail='[withheld: secret-shaped content]'
        OR instr(output_tail,'[withheld line: ') > 0 THEN 1
      ELSE 0
    END;
-- /BACKFILL
