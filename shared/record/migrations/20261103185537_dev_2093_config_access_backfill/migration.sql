ALTER TABLE membership NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE membership SET config_access=true WHERE role='owner';--> statement-breakpoint
ALTER TABLE membership FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_key_claim_challenge" FORCE ROW LEVEL SECURITY;
