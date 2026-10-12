DROP TABLE hosted_change_evidence;
--> statement-breakpoint
INSERT OR IGNORE INTO install_binding (id, bound, active_space_id, bound_at)
SELECT 1, 1, NULL, datetime('now')
WHERE EXISTS (
  SELECT 1 FROM setting
  WHERE key = 'collect.hosted-tasks.cursor'
     OR key LIKE 'collect.hosted-tasks.cursor.%'
     OR key = 'collect.hosted-notes.cursor'
     OR key LIKE 'collect.hosted-notes.cursor.%'
);
--> statement-breakpoint
DELETE FROM setting
WHERE key = 'collect.hosted-tasks.cursor'
   OR key LIKE 'collect.hosted-tasks.cursor.%'
   OR key = 'collect.hosted-notes.cursor'
   OR key LIKE 'collect.hosted-notes.cursor.%'
   OR key = 'collect.hosted-sends.cursor';
