ALTER TABLE "run" ADD CONSTRAINT "run_sandbox_check" CHECK ("sandbox" IN ('host', 'srt')) NOT VALID;
