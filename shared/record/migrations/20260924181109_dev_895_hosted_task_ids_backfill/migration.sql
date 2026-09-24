UPDATE hub_task child
SET parent_id = parent.id
FROM hub_task parent
WHERE child.parent_id IS NULL
  AND child.parent_key IS NOT NULL
  AND parent.space_id = child.space_id
  AND parent.key = child.parent_key;

UPDATE hub_task_comment child
SET task_id = task.id
FROM hub_task task
WHERE child.task_id IS NULL
  AND task.space_id = child.space_id
  AND task.key = child.task_key;

UPDATE hub_task_document child
SET task_id = task.id
FROM hub_task task
WHERE child.task_id IS NULL
  AND task.space_id = child.space_id
  AND task.key = child.task_key;

UPDATE hub_task_status_event child
SET task_id = task.id
FROM hub_task task
WHERE child.task_id IS NULL
  AND task.space_id = child.space_id
  AND task.key = child.task_key;

UPDATE hub_note note
SET promoted_task_id = task.id
FROM hub_task task
WHERE note.promoted_task_id IS NULL
  AND note.promoted_task IS NOT NULL
  AND task.space_id = note.space_id
  AND task.key = note.promoted_task;

DO $$
DECLARE
  unresolved_parent bigint;
  unresolved_comment bigint;
  unresolved_document bigint;
  unresolved_status_event bigint;
  unresolved_promotion bigint;
BEGIN
  SELECT count(*) INTO unresolved_parent
  FROM hub_task WHERE parent_key IS NOT NULL AND parent_id IS NULL;
  SELECT count(*) INTO unresolved_comment
  FROM hub_task_comment WHERE task_id IS NULL;
  SELECT count(*) INTO unresolved_document
  FROM hub_task_document WHERE task_id IS NULL;
  SELECT count(*) INTO unresolved_status_event
  FROM hub_task_status_event WHERE task_id IS NULL;
  SELECT count(*) INTO unresolved_promotion
  FROM hub_note WHERE promoted_task IS NOT NULL AND promoted_task_id IS NULL;

  RAISE NOTICE 'DEV-895 unresolved hosted task references: parent=%, comment=%, document=%, status_event=%, promotion=%',
    unresolved_parent, unresolved_comment, unresolved_document, unresolved_status_event,
    unresolved_promotion;
END $$;
