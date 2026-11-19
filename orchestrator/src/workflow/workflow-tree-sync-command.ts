// concern: workflow tree synchronization command
/** Composes the import-then-promote command sequence for one workflow tree. */

export type WorkflowTreeSyncCommand = {
  stage: 'import' | 'promote'
  argv: string[]
}

export function workflowTreeSyncCommands(
  binary: string,
  cwd: string,
  reason: string,
  since?: string | null,
): WorkflowTreeSyncCommand[] {
  return [
    {
      stage: 'import',
      argv: [
        binary,
        'workflow',
        'import',
        '--cwd',
        cwd,
        '--reason',
        reason,
        ...(since ? ['--since', since] : []),
      ],
    },
    {
      stage: 'promote',
      argv: [binary, 'workflow', 'promote-tree', '--cwd', cwd, '--reason', reason],
    },
  ]
}
