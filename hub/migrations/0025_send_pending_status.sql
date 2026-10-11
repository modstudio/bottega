CREATE TABLE send_pending_status (
  record_id TEXT NOT NULL PRIMARY KEY,
  at TEXT NOT NULL,
  window TEXT NOT NULL,
  recipients TEXT NOT NULL,
  projects TEXT NOT NULL,
  items INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','skipped','failed')),
  error TEXT,
  test INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO send_pending_status(record_id,at,window,recipients,projects,items,status,error,test)
SELECT record_id,at,window,recipients,projects,items,status,error,test FROM send;
--> statement-breakpoint
DROP TABLE send;
--> statement-breakpoint
ALTER TABLE send_pending_status RENAME TO send;
