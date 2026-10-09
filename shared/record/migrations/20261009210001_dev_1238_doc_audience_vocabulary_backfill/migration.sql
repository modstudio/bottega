ALTER TABLE "doc" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_revision" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "doc" AS d
SET "audiences" = (
  SELECT array_agg(mapped ORDER BY ordinality)
  FROM (
    SELECT mapped, ordinality,
      row_number() OVER (PARTITION BY mapped ORDER BY ordinality) AS occurrence
    FROM (
      SELECT CASE WHEN audience = 'user' THEN
        CASE WHEN EXISTS (
          SELECT 1 FROM public_doc_space public_space
          WHERE public_space.space_id = d.space_id
            AND public_space.project_id = d.project_id
        ) THEN 'customer' ELSE 'internal' END
      ELSE audience END AS mapped, ordinality
      FROM unnest(d.audiences) WITH ORDINALITY AS source(audience, ordinality)
    ) mapped_values
  ) deduplicated
  WHERE occurrence = 1
)
WHERE 'user' = ANY(d.audiences);--> statement-breakpoint
UPDATE "doc_revision" AS r
SET "audiences" = (
  SELECT array_agg(mapped ORDER BY ordinality)
  FROM (
    SELECT mapped, ordinality,
      row_number() OVER (PARTITION BY mapped ORDER BY ordinality) AS occurrence
    FROM (
      SELECT CASE WHEN audience = 'user' THEN
        CASE WHEN EXISTS (
          SELECT 1 FROM public_doc_space public_space
          WHERE public_space.space_id = r.space_id
            AND public_space.project_id = r.project_id
        ) THEN 'customer' ELSE 'internal' END
      ELSE audience END AS mapped, ordinality
      FROM unnest(r.audiences) WITH ORDINALITY AS source(audience, ordinality)
    ) mapped_values
  ) deduplicated
  WHERE occurrence = 1
)
WHERE 'user' = ANY(r.audiences);--> statement-breakpoint
ALTER TABLE "doc" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_revision" FORCE ROW LEVEL SECURITY;
