-- Historical outside-worktree status snapshots used NUL separators. The ruled stored form uses newlines.
-- BACKFILL
UPDATE run
   SET outside_worktree_writes = replace(outside_worktree_writes, '\u0000', '\n')
 WHERE instr(outside_worktree_writes, '\u0000') > 0;
-- /BACKFILL
