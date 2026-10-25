ALTER TABLE review ADD COLUMN round INTEGER;
ALTER TABLE review_lens ADD COLUMN selection_reason TEXT;
ALTER TABLE run ADD COLUMN selection_reason TEXT;

-- BACKFILL
CREATE TEMP TABLE review_round_source (
  review_record_id TEXT PRIMARY KEY,
  project_record_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  number INTEGER NOT NULL,
  branch TEXT,
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
  WHERE r.role='round'
    AND run.project_record_id IS NOT NULL
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
SELECT review_record_id,project_record_id,recorded_at,number,branch,task,
       CASE WHEN task IS NOT NULL AND trim(COALESCE(patch_id,'')) != ''
            THEN lower(task) || char(0) || patch_id || char(0) || COALESCE(path_set,'') END
FROM classified;

CREATE TEMP TABLE review_round_backfill (
  review_record_id TEXT PRIMARY KEY,
  round INTEGER NOT NULL
);

INSERT INTO review_round_backfill
WITH RECURSIVE
ranked_mints AS (
  SELECT project_record_id,minted_branch,launch_base,launch_key,
         ROW_NUMBER() OVER (
           PARTITION BY project_record_id,minted_branch ORDER BY number DESC
         ) AS preference
  FROM run
  WHERE minted_branch IS NOT NULL
),
mint_facts AS (
  SELECT project_record_id,minted_branch,launch_base,launch_key
  FROM ranked_mints WHERE preference=1
),
lineage(root_review_id,project_record_id,branch,launch_key,visited) AS (
  SELECT review_record_id,project_record_id,branch,NULL,',' || branch || ','
  FROM review_round_source
  WHERE branch IS NOT NULL
  UNION ALL
  SELECT lineage.root_review_id,lineage.project_record_id,ancestor.minted_branch,
         ancestor.launch_key,lineage.visited || ancestor.minted_branch || ','
  FROM lineage
  JOIN mint_facts descendant
    ON descendant.project_record_id=lineage.project_record_id
   AND descendant.minted_branch=lineage.branch
  JOIN mint_facts ancestor
    ON ancestor.project_record_id=lineage.project_record_id
   AND ancestor.minted_branch=CASE
         WHEN descendant.launch_base LIKE 'refs/heads/%'
         THEN substr(descendant.launch_base,length('refs/heads/')+1)
         ELSE descendant.launch_base
       END
   AND ancestor.launch_key=descendant.launch_key
  WHERE descendant.launch_base IS NOT NULL
    AND instr(lineage.visited,',' || ancestor.minted_branch || ',')=0
),
first_seen AS (
  SELECT lineage.root_review_id,source.project_record_id,lower(source.task) AS task,
         source.identity,
         MIN(recorded_at || printf('%010d',number)) AS first_key
  FROM lineage
  JOIN review_round_source source
    ON source.project_record_id=lineage.project_record_id
   AND source.branch=lineage.branch
  WHERE source.task IS NOT NULL AND source.identity IS NOT NULL
  GROUP BY lineage.root_review_id,source.project_record_id,lower(source.task),source.identity
),
ordinals AS (
  SELECT root_review_id,project_record_id,task,identity,
         ROW_NUMBER() OVER (PARTITION BY root_review_id,project_record_id,task ORDER BY first_key) AS round
  FROM first_seen
)
SELECT source.review_record_id,ordinals.round
FROM review_round_source source
JOIN ordinals
  ON ordinals.root_review_id=source.review_record_id
 AND ordinals.project_record_id=source.project_record_id
 AND ordinals.task=lower(source.task)
 AND ordinals.identity=source.identity;

UPDATE review
SET round=(SELECT round FROM review_round_backfill WHERE review_record_id=review.record_id)
WHERE round IS NULL
  AND record_id IN (SELECT review_record_id FROM review_round_backfill);

DROP TABLE review_round_backfill;
DROP TABLE review_round_source;
-- /BACKFILL
