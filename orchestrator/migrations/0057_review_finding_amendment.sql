CREATE TABLE review_finding_amendment (
  review_id             INTEGER NOT NULL REFERENCES review(id),
  finding_ordinal       INTEGER NOT NULL,
  old_disposition       TEXT CHECK (old_disposition IN ('accepted','modified','rejected','skipped')),
  new_disposition       TEXT NOT NULL CHECK (new_disposition IN ('accepted','modified','rejected','skipped')),
  old_rejection_category TEXT,
  new_rejection_category TEXT,
  old_triaged_severity  TEXT CHECK (old_triaged_severity IN ('critical','high','medium','low')),
  new_triaged_severity  TEXT CHECK (new_triaged_severity IN ('critical','high','medium','low')),
  reason                TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_session         TEXT CHECK (actor_session IS NULL OR length(actor_session) > 0),
  at                    TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX review_finding_amendment_review
  ON review_finding_amendment(review_id, finding_ordinal, at);
