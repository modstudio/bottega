ALTER TABLE agent ADD COLUMN route_metered INTEGER NOT NULL DEFAULT 0 CHECK (route_metered IN (0,1));
--> statement-breakpoint
ALTER TABLE run ADD COLUMN transport_explicit INTEGER NOT NULL DEFAULT 0 CHECK (transport_explicit IN (0,1));
