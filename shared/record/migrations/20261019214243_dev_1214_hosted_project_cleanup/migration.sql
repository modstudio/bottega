ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
ALTER TABLE doc NO FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_revision NO FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_related_subject NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task_comment NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task_document NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task_status_event NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_note NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_note_acknowledgement NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_report_subscription NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_interval NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  ambiguous_doc bigint;
  ambiguous_revision bigint;
  ambiguous_hub bigint;
  destination_collisions text;
BEGIN
  DROP TABLE IF EXISTS dev_1214_live_project_match;
  DROP TABLE IF EXISTS dev_1214_resume_move;
  CREATE TEMP TABLE dev_1214_live_project_match ON COMMIT DROP AS
  SELECT space_id, name, min(id::text)::uuid AS project_id
  FROM project
  WHERE retired_at IS NULL
  GROUP BY space_id, name
  HAVING count(*) = 1;

  SELECT count(*) INTO ambiguous_doc
  FROM doc d
  WHERE d.project_id IS NULL
    AND d.scope IN ('project', 'resume', 'canon', 'settings')
    AND d.subject IS NOT NULL
    AND (SELECT count(*) FROM project p
         WHERE p.retired_at IS NULL AND p.space_id=d.space_id AND p.name=d.subject) > 1;
  SELECT count(*) INTO ambiguous_revision
  FROM doc_revision r
  WHERE r.project_id IS NULL
    AND r.scope IN ('project', 'resume', 'canon', 'settings')
    AND r.subject IS NOT NULL
    AND (SELECT count(*) FROM project p
         WHERE p.retired_at IS NULL AND p.space_id=r.space_id AND p.name=r.subject) > 1;

  CREATE TEMP TABLE dev_1214_resume_move ON COMMIT DROP AS
  SELECT d.id AS doc_id, d.space_id AS source_space_id,
    destination.space_id AS destination_space_id, destination.project_id,
    d.scope, d.subject, d.owner_user_id, d.slug
  FROM doc d
  JOIN (
    SELECT name, min(space_id::text)::uuid AS space_id, min(id::text)::uuid AS project_id
    FROM project
    WHERE retired_at IS NULL
    GROUP BY name
    HAVING count(*) = 1
  ) destination ON destination.name=d.subject AND destination.space_id<>d.space_id
  WHERE d.scope='resume' AND d.project_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM project local_project
      WHERE local_project.retired_at IS NULL
        AND local_project.space_id=d.space_id AND local_project.name=d.subject
    );

  SELECT string_agg(
    format('%s/%s/%s', moving.scope, coalesce(moving.subject, '_'), moving.slug),
    ', ' ORDER BY moving.scope, moving.subject, moving.slug
  ) INTO destination_collisions
  FROM dev_1214_resume_move moving
  WHERE EXISTS (
    SELECT 1 FROM doc destination
    WHERE destination.space_id=moving.destination_space_id
      AND destination.scope=moving.scope
      AND destination.subject IS NOT DISTINCT FROM moving.subject
      AND destination.owner_user_id IS NOT DISTINCT FROM moving.owner_user_id
      AND destination.slug=moving.slug
      AND destination.id<>moving.doc_id
  );
  IF destination_collisions IS NOT NULL THEN
    RAISE EXCEPTION
      'DEV-1214 cannot move resume documents because destination addresses already exist: %',
      destination_collisions;
  END IF;

  UPDATE doc d SET project_id=match.project_id
  FROM dev_1214_live_project_match match
  WHERE d.project_id IS NULL
    AND d.scope IN ('project', 'resume', 'canon', 'settings')
    AND d.subject=match.name AND d.space_id=match.space_id;
  UPDATE doc_revision r SET project_id=match.project_id
  FROM dev_1214_live_project_match match
  WHERE r.project_id IS NULL
    AND r.scope IN ('project', 'resume', 'canon', 'settings')
    AND r.subject=match.name AND r.space_id=match.space_id;

  UPDATE hub_task row SET project_id=match.project_id
  FROM dev_1214_live_project_match match
  WHERE row.project_id IS NULL AND row.space_id=match.space_id
    AND (row.project_name=match.name OR row.project=match.name)
    AND NOT EXISTS (
      SELECT 1 FROM dev_1214_live_project_match other
      WHERE other.space_id=row.space_id
        AND (other.name=row.project_name OR other.name=row.project)
        AND other.project_id<>match.project_id
    );
  UPDATE hub_note row SET project_id=match.project_id
  FROM dev_1214_live_project_match match
  WHERE row.project_id IS NULL AND row.space_id=match.space_id
    AND (row.project_name=match.name OR row.project=match.name)
    AND NOT EXISTS (
      SELECT 1 FROM dev_1214_live_project_match other
      WHERE other.space_id=row.space_id
        AND (other.name=row.project_name OR other.name=row.project)
        AND other.project_id<>match.project_id
    );
  UPDATE hub_task_comment row SET project_id=match.project_id
  FROM dev_1214_live_project_match match
  WHERE row.project_id IS NULL AND row.space_id=match.space_id AND row.project_name=match.name;
  UPDATE hub_task_document row SET project_id=match.project_id
  FROM dev_1214_live_project_match match
  WHERE row.project_id IS NULL AND row.space_id=match.space_id AND row.project_name=match.name;
  UPDATE hub_task_status_event row SET project_id=match.project_id
  FROM dev_1214_live_project_match match
  WHERE row.project_id IS NULL AND row.space_id=match.space_id AND row.project_name=match.name;
  UPDATE hub_note_acknowledgement row SET project_id=match.project_id
  FROM dev_1214_live_project_match match
  WHERE row.project_id IS NULL AND row.space_id=match.space_id AND row.project_name=match.name;
  UPDATE hub_report_subscription row SET project_id=match.project_id
  FROM dev_1214_live_project_match match
  WHERE row.project_id IS NULL AND row.space_id=match.space_id AND row.project_name=match.name;
  UPDATE hub_interval row SET project_id=match.project_id
  FROM dev_1214_live_project_match match
  WHERE row.project_id IS NULL AND row.space_id=match.space_id AND row.project_name=match.name;

  SELECT count(*) INTO ambiguous_hub FROM (
    SELECT id FROM hub_task row WHERE row.project_id IS NULL AND
      (SELECT count(DISTINCT match.project_id) FROM dev_1214_live_project_match match
       WHERE match.space_id=row.space_id AND (match.name=row.project_name OR match.name=row.project)) > 1
    UNION ALL
    SELECT id FROM hub_note row WHERE row.project_id IS NULL AND
      (SELECT count(DISTINCT match.project_id) FROM dev_1214_live_project_match match
       WHERE match.space_id=row.space_id AND (match.name=row.project_name OR match.name=row.project)) > 1
  ) ambiguous;
  RAISE NOTICE 'DEV-1214 ambiguous same-space project names left unchanged: doc=%, revision=%, hub=%',
    ambiguous_doc, ambiguous_revision, ambiguous_hub;

  UPDATE doc_related_subject related SET space_id=moving.destination_space_id
  FROM dev_1214_resume_move moving
  WHERE related.doc_id=moving.doc_id AND related.space_id=moving.source_space_id;
  UPDATE doc_revision revision
  SET space_id=moving.destination_space_id, project_id=moving.project_id
  FROM dev_1214_resume_move moving
  WHERE revision.space_id=moving.source_space_id
    AND revision.scope=moving.scope
    AND revision.subject IS NOT DISTINCT FROM moving.subject
    AND revision.owner_user_id IS NOT DISTINCT FROM moving.owner_user_id
    AND revision.slug=moving.slug;
  UPDATE doc document
  SET space_id=moving.destination_space_id, project_id=moving.project_id
  FROM dev_1214_resume_move moving
  WHERE document.id=moving.doc_id;
END $$;

ALTER TABLE project FORCE ROW LEVEL SECURITY;
ALTER TABLE doc FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_related_subject FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task_comment FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task_document FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task_status_event FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_note FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_note_acknowledgement FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_report_subscription FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_interval FORCE ROW LEVEL SECURITY;
