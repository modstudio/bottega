-- Historical outside-worktree status snapshots used NUL separators. The ruled stored form uses newlines.
-- BACKFILL
UPDATE run
   SET outside_worktree_writes = replace(outside_worktree_writes, '\u0000', '\n')
 WHERE instr(outside_worktree_writes, '\u0000') > 0;

-- A delivered outbox row whose payload was released holds no JSON, so the block skips it.
UPDATE outbox
   SET payload = json_set(
     payload,
     '$.outsideWorktreeWrites',
     json(replace(json_extract(payload, '$.outsideWorktreeWrites'), '\u0000', '\n'))
   )
 WHERE kind = 'run'
   AND CASE WHEN json_valid(payload) THEN
     json_type(payload, '$.outsideWorktreeWrites') IS NOT NULL
     AND instr(json_extract(payload, '$.outsideWorktreeWrites'), '\u0000') > 0
   ELSE 0 END;
-- /BACKFILL
