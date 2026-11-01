SELECT set_config('lock_timeout', current_setting('record_migration.lock_timeout'), true);--> statement-breakpoint
SELECT set_config('statement_timeout', current_setting('record_migration.statement_timeout'), true);
