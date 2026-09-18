DROP POLICY "hub_send_recipient_space_update" ON "hub_send_recipient";--> statement-breakpoint
DROP POLICY "hub_send_recipient_space_delete" ON "hub_send_recipient";--> statement-breakpoint
ALTER POLICY "hub_send_recipient_space_select" ON "hub_send_recipient" TO public USING ("hub_send_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid
        OR "hub_send_recipient"."space_id" = ANY(
          string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
        ));--> statement-breakpoint
-- A send is a space-level ledger even when its subscription has project scope.
-- Keep both the ledger and its immutable recipient snapshots out of project moves.
DO $migration$
DECLARE
  definition text;
  candidate_fragment text := $fragment$AND NOT EXISTS (SELECT 1 FROM move_plan mp WHERE mp.name=c.table_name)
      ORDER BY c.table_name$fragment$;
  excluded_fragment text := $fragment$AND c.table_name <> 'hub_send'
        AND NOT EXISTS (SELECT 1 FROM move_plan mp WHERE mp.name=c.table_name)
      ORDER BY c.table_name$fragment$;
  send_reason text := $fragment$WHEN 'hub_send' THEN 'space send; projects may name several projects'$fragment$;
  recipient_reason text := $fragment$WHEN 'hub_send' THEN 'space send; projects may name several projects'
          WHEN 'hub_send_recipient' THEN 'space send recipient; parent send is not project-attributable'$fragment$;
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
  INTO definition;
  IF position(candidate_fragment IN definition) = 0 OR position(send_reason IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space definition does not match the expected predecessor';
  END IF;
  definition := replace(definition, candidate_fragment, excluded_fragment);
  definition := replace(definition, send_reason, recipient_reason);
  EXECUTE definition;
END
$migration$;
