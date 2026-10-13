ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE board_message SET purpose = 'information' WHERE kind <> 'reply' AND purpose IS NULL;--> statement-breakpoint
ALTER TABLE board_message FORCE ROW LEVEL SECURITY;
