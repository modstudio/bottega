// concern: workflow tree synchronization command
/** Composes the import-then-promote command sequence for one workflow tree. */

export function workflowTreeSyncCommands(
  binary: string,
  cwd: string,
  reason: string,
  since?: string | null,
): { import: string[]; promote: string[] } {
  return {
    import: [
      binary,
      'workflow',
      'import',
      '--cwd',
      cwd,
      '--reason',
      reason,
      ...(since ? ['--since', since] : []),
    ],
    promote: [binary, 'workflow', 'promote-tree', '--cwd', cwd, '--reason', reason],
  }
}
