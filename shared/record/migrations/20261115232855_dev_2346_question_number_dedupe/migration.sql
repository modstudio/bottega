ALTER TABLE "question" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "question_number_counter" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
WITH ranked_questions AS (
  SELECT
    id,
    space_id,
    asked_at,
    row_number() OVER (
      PARTITION BY space_id, number
      ORDER BY asked_at, id
    ) AS duplicate_ordinal,
    count(*) OVER (PARTITION BY space_id, number) AS duplicate_count
  FROM question
  WHERE number IS NOT NULL
),
space_bases AS (
  SELECT
    spaces.space_id,
    greatest(
      COALESCE(MAX(question.number)::bigint, 0),
      COALESCE(MAX(counter.next) - 1, 0)
    ) AS base_number
  FROM (SELECT DISTINCT space_id FROM ranked_questions) spaces
  LEFT JOIN question ON question.space_id = spaces.space_id
  LEFT JOIN question_number_counter counter ON counter.space_id = spaces.space_id
  GROUP BY spaces.space_id
),
duplicate_losers AS (
  SELECT
    ranked.id,
    ranked.space_id,
    row_number() OVER (
      PARTITION BY ranked.space_id
      ORDER BY ranked.asked_at, ranked.id
    ) AS fresh_ordinal
  FROM ranked_questions ranked
  WHERE ranked.duplicate_count > 1
    AND ranked.duplicate_ordinal > 1
),
fresh_numbers AS (
  SELECT
    duplicate_losers.id,
    space_bases.base_number + duplicate_losers.fresh_ordinal AS number
  FROM duplicate_losers
  JOIN space_bases USING (space_id)
)
UPDATE question
SET number = fresh_numbers.number
FROM fresh_numbers
WHERE question.id = fresh_numbers.id;
--> statement-breakpoint
INSERT INTO question_number_counter (space_id, next)
SELECT
  spaces.space_id,
  COALESCE(MAX(question.number)::bigint + 1, 1)
FROM (SELECT DISTINCT space_id FROM question) spaces
LEFT JOIN question ON question.space_id = spaces.space_id
GROUP BY spaces.space_id
ON CONFLICT (space_id) DO UPDATE
SET next = greatest(question_number_counter.next, excluded.next);
--> statement-breakpoint
ALTER TABLE "question_number_counter" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "question" FORCE ROW LEVEL SECURITY;
