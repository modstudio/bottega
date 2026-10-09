ALTER TABLE space NO FORCE ROW LEVEL SECURITY;
ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_note NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_note_acknowledgement NO FORCE ROW LEVEL SECURITY;
ALTER TABLE seq NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  source_space uuid;
  destination_space uuid;
  destination_project uuid;
  highest_number bigint;
  misplaced_promotions bigint;
BEGIN
  SELECT id INTO source_space FROM space WHERE slug = 'bottega';
  SELECT id INTO destination_space FROM space WHERE slug = 'stopal';

  IF source_space IS NULL OR destination_space IS NULL THEN
    IF EXISTS (SELECT 1 FROM hub_note WHERE project_name = 'stopal') THEN
      RAISE EXCEPTION 'cannot move stopal notes: bottega or stopal space slug is absent';
    END IF;
    RETURN;
  END IF;

  SELECT id INTO destination_project
  FROM project WHERE space_id = destination_space AND name = 'stopal';

  IF destination_project IS NULL AND EXISTS (
    SELECT 1 FROM hub_note WHERE space_id = source_space AND project_name = 'stopal'
  ) THEN
    RAISE EXCEPTION 'cannot move stopal notes: destination project row is absent';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM hub_note source
    JOIN hub_note destination
      ON destination.space_id = destination_space
     AND destination.project_name = 'stopal'
     AND destination.number = source.number
     AND destination.id <> source.id
    WHERE source.space_id = source_space AND source.project_name = 'stopal'
  ) THEN
    RAISE EXCEPTION 'cannot move stopal notes: destination project-number collision';
  END IF;

  UPDATE hub_note_acknowledgement acknowledgement
  SET space_id = destination_space, updated_at = now()
  WHERE acknowledgement.space_id = source_space
    AND acknowledgement.note_id IN (
      SELECT id FROM hub_note WHERE space_id = source_space AND project_name = 'stopal'
    );

  UPDATE hub_note
  SET space_id = destination_space, updated_at = now()
  WHERE space_id = source_space AND project_name = 'stopal';

  SELECT max(number) INTO highest_number
  FROM hub_note WHERE space_id = destination_space AND project_name = 'stopal';

  IF highest_number IS NOT NULL THEN
    INSERT INTO seq (space_id, project_id, name, next)
    VALUES (destination_space, destination_project, 'note', highest_number + 1)
    ON CONFLICT (space_id, project_id, name) DO UPDATE
    SET next = greatest(seq.next, excluded.next);
  END IF;

  SELECT count(*) INTO misplaced_promotions
  FROM hub_note note
  LEFT JOIN hub_task task
    ON task.id = note.promoted_task_id AND task.space_id = destination_space
  WHERE note.space_id = destination_space
    AND note.project_name = 'stopal'
    AND note.promoted_task_id IS NOT NULL
    AND task.id IS NULL;

  IF misplaced_promotions > 0 THEN
    RAISE NOTICE 'DEV-1212 stopal notes retain % promoted-task links outside the destination space',
      misplaced_promotions;
  END IF;
END $$;

ALTER TABLE space FORCE ROW LEVEL SECURITY;
ALTER TABLE project FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_note FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_note_acknowledgement FORCE ROW LEVEL SECURITY;
ALTER TABLE seq FORCE ROW LEVEL SECURITY;
