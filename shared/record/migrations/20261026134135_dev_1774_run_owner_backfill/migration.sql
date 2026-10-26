ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "run" AS run_row
SET started_by_user_id = machine_row.user_id
FROM machine AS machine_row
WHERE run_row.started_by_user_id IS NULL
  AND machine_row.id = run_row.machine_id;
--> statement-breakpoint
DO $$
DECLARE
  ownerless_run_count bigint;
BEGIN
  SELECT count(*) INTO ownerless_run_count
  FROM "run"
  WHERE started_by_user_id IS NULL;

  IF ownerless_run_count > 0 THEN
    RAISE EXCEPTION 'DEV-1774 hosted runs still missing started_by_user_id: %', ownerless_run_count;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "run" FORCE ROW LEVEL SECURITY;
