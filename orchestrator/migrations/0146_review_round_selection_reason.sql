ALTER TABLE review ADD COLUMN round INTEGER;
ALTER TABLE review_lens ADD COLUMN selection_reason TEXT;
ALTER TABLE run ADD COLUMN selection_reason TEXT;

-- BACKFILL
CREATE TEMP TABLE review_round_source (
  review_record_id TEXT PRIMARY KEY,
  project_record_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  number INTEGER NOT NULL,
  task TEXT,
  identity TEXT
);

INSERT INTO review_round_source
WITH RECURSIVE
evidence AS (
  SELECT r.record_id AS review_record_id,r.recorded_at,r.number,r.patch_id,r.path_set,
         run.project_record_id,run.launch_key,run.branch,
         ROW_NUMBER() OVER (PARTITION BY r.record_id ORDER BY rl.record_id) AS evidence_ordinal
  FROM review r
  JOIN review_lens rl ON rl.review_record_id=r.record_id
  JOIN run ON run.record_id=rl.run_record_id
  WHERE run.project_record_id IS NOT NULL
    AND run.evidence_excluded IS NULL
    AND COALESCE(run.probe,0)=0
    AND NOT EXISTS (
      SELECT 1 FROM score review_score
      WHERE review_score.run_record_id=rl.run_record_id AND review_score.delivery='none'
    )
),
scan(review_record_id,branch,pos,token) AS (
  SELECT review_record_id,branch,1,
         CASE WHEN substr(branch,1,1) GLOB '[A-Za-z0-9-]' THEN upper(substr(branch,1,1)) ELSE '' END
  FROM evidence WHERE evidence_ordinal=1 AND branch IS NOT NULL
  UNION ALL
  SELECT review_record_id,branch,pos+1,
         CASE WHEN substr(branch,pos+1,1) GLOB '[A-Za-z0-9-]'
              THEN token || upper(substr(branch,pos+1,1)) ELSE '' END
  FROM scan WHERE pos < length(branch)
),
branch_task AS (
  SELECT review_record_id,token AS task,
         ROW_NUMBER() OVER (PARTITION BY review_record_id ORDER BY pos) AS candidate_ordinal
  FROM scan
  WHERE token != ''
    AND (pos=length(branch) OR substr(branch,pos+1,1) NOT GLOB '[0-9]')
    AND instr(token,'-') > 1
    AND substr(token,1,1) GLOB '[A-Z]'
    AND substr(token,instr(token,'-')+1) != ''
    AND substr(token,instr(token,'-')+1) NOT GLOB '*[^0-9]*'
),
classified AS (
  SELECT evidence.*,
         CASE WHEN trim(COALESCE(launch_key,'')) != '' THEN upper(trim(launch_key))
              ELSE branch_task.task END AS task
  FROM evidence
  LEFT JOIN branch_task
    ON branch_task.review_record_id=evidence.review_record_id
   AND branch_task.candidate_ordinal=1
  WHERE evidence_ordinal=1
)
SELECT review_record_id,project_record_id,recorded_at,number,task,
       CASE WHEN task IS NOT NULL AND trim(COALESCE(patch_id,'')) != ''
            THEN lower(task) || char(0) || patch_id || char(0) || COALESCE(path_set,'') END
FROM classified;

CREATE TEMP TABLE review_round_backfill (
  review_record_id TEXT PRIMARY KEY,
  round INTEGER NOT NULL
);

INSERT INTO review_round_backfill
WITH first_seen AS (
  SELECT project_record_id,lower(task) AS task,identity,
         MIN(recorded_at || printf('%010d',number)) AS first_key
  FROM review_round_source
  WHERE task IS NOT NULL AND identity IS NOT NULL
  GROUP BY project_record_id,lower(task),identity
),
ordinals AS (
  SELECT project_record_id,task,identity,
         ROW_NUMBER() OVER (PARTITION BY project_record_id,task ORDER BY first_key) AS round
  FROM first_seen
)
SELECT source.review_record_id,ordinals.round
FROM review_round_source source
JOIN ordinals
  ON ordinals.project_record_id=source.project_record_id
 AND ordinals.task=lower(source.task)
 AND ordinals.identity=source.identity;

UPDATE review
SET round=(SELECT round FROM review_round_backfill WHERE review_record_id=review.record_id)
WHERE round IS NULL
  AND record_id IN (SELECT review_record_id FROM review_round_backfill);

DROP TABLE review_round_backfill;
DROP TABLE review_round_source;
-- /BACKFILL
