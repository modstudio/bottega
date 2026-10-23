ALTER TABLE review ADD COLUMN round INTEGER;
ALTER TABLE review_lens ADD COLUMN selection_reason TEXT;

-- BACKFILL
CREATE TEMP TABLE review_round_backfill (
  review_record_id TEXT PRIMARY KEY,
  round INTEGER NOT NULL
);
INSERT INTO review_round_backfill
SELECT classified.review_record_id, ordinals.round
FROM (
  SELECT
    review_record_id,
    recorded_at,
    number,
    repo,
    branch,
    CASE
      WHEN patch_id IS NULL THEN NULL
      WHEN launch_key IS NOT NULL AND trim(launch_key) != ''
        THEN lower(trim(launch_key)) || char(0) || patch_id || char(0) || COALESCE(path_set, '')
      ELSE NULL
    END AS identity
  FROM (
    SELECT
      r.record_id AS review_record_id,
      r.recorded_at,
      r.number,
      r.patch_id,
      r.path_set,
      run.repo,
      run.branch,
      run.launch_key
    FROM review r
    JOIN review_lens rl ON rl.review_record_id=r.record_id
    JOIN run ON run.record_id=rl.run_record_id
    WHERE run.evidence_excluded IS NULL
      AND COALESCE(run.probe, 0) = 0
      AND NOT EXISTS (
        SELECT 1 FROM score review_score
        WHERE review_score.run_record_id=rl.run_record_id AND review_score.delivery='none'
      )
      AND run.branch IS NOT NULL
    GROUP BY r.record_id
  )
) AS classified
JOIN (
  SELECT
    repo,
    branch,
    identity,
    ROW_NUMBER() OVER (
      PARTITION BY repo, branch
      ORDER BY first_key
    ) AS round
  FROM (
    SELECT
      repo,
      branch,
      identity,
      MIN(recorded_at || printf('%010d', number)) AS first_key
    FROM (
      SELECT
        review_record_id,
        recorded_at,
        number,
        repo,
        branch,
        CASE
          WHEN patch_id IS NULL THEN NULL
          WHEN launch_key IS NOT NULL AND trim(launch_key) != ''
            THEN lower(trim(launch_key)) || char(0) || patch_id || char(0) || COALESCE(path_set, '')
          ELSE NULL
        END AS identity
      FROM (
        SELECT
          r.record_id AS review_record_id,
          r.recorded_at,
          r.number,
          r.patch_id,
          r.path_set,
          run.repo,
          run.branch,
          run.launch_key
        FROM review r
        JOIN review_lens rl ON rl.review_record_id=r.record_id
        JOIN run ON run.record_id=rl.run_record_id
        WHERE run.evidence_excluded IS NULL
          AND COALESCE(run.probe, 0) = 0
          AND NOT EXISTS (
            SELECT 1 FROM score review_score
            WHERE review_score.run_record_id=rl.run_record_id AND review_score.delivery='none'
          )
          AND run.branch IS NOT NULL
        GROUP BY r.record_id
      )
    )
    WHERE identity IS NOT NULL
    GROUP BY repo, branch, identity
  )
) AS ordinals
  ON ordinals.repo IS classified.repo
 AND ordinals.branch = classified.branch
 AND ordinals.identity = classified.identity
WHERE classified.identity IS NOT NULL;
UPDATE review
SET round = (
  SELECT round FROM review_round_backfill WHERE review_record_id=review.record_id
)
WHERE record_id IN (SELECT review_record_id FROM review_round_backfill);
DROP TABLE review_round_backfill;
-- /BACKFILL
