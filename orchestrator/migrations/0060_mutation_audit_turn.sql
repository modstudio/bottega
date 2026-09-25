ALTER TABLE run_mutation_audit ADD COLUMN turn_id INTEGER REFERENCES run(id);
--> statement-breakpoint
CREATE INDEX run_mutation_audit_turn ON run_mutation_audit(turn_id);
