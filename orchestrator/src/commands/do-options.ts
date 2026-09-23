// concern: cli
/** The `orch do` CLI options, shared with catalogue command validation. */
export const ORCH_DO_OPTIONS = [
  { flags: '--agent <value>', name: 'agent', value: 'required' },
  { flags: '--avoid <value>', name: 'avoid', value: 'required' },
  { flags: '--distinct-from <value>', name: 'distinct-from', value: 'required' },
  { flags: '--base <value>', name: 'base', value: 'required' },
  { flags: '--review <value>', name: 'review', value: 'required' },
  { flags: '--file <value>', name: 'file', value: 'required' },
  { flags: '--schema <value>', name: 'schema', value: 'required' },
  { flags: '--model <value>', name: 'model', value: 'required' },
  { flags: '--transport <value>', name: 'transport', value: 'required' },
  { flags: '--label <value>', name: 'label', value: 'required' },
  { flags: '--lens <value>', name: 'lens', value: 'required' },
  { flags: '--seed <value>', name: 'seed', value: 'required' },
  { flags: '--key <value>', name: 'key', value: 'required' },
  { flags: '--repo <value>', name: 'repo', value: 'required' },
  { flags: '--cwd <value>', name: 'cwd', value: 'required' },
  { flags: '--deliverable <value>', name: 'deliverable', value: 'required' },
  { flags: '--timeout <value>', name: 'timeout', value: 'required' },
  { flags: '--carry' },
  { flags: '--quiet' },
  { flags: '--probe' },
  { flags: '--follow' },
  { flags: '--detach' },
  { flags: '--porcelain' },
  { flags: '--no-failover' },
  { flags: '--keep-tree [hours]', name: 'keep-tree', value: 'optional' },
  { flags: '--keep-tree-reason <text>', name: 'keep-tree-reason', value: 'required' },
  { flags: '--no-wait-capacity' },
  { flags: '--mcp [mode]', name: 'mcp', value: 'optional' },
] as const

export const orchDoValueOptionNames: ReadonlyMap<string, 'required' | 'optional'> = new Map(
  ORCH_DO_OPTIONS.flatMap((option) =>
    'name' in option ? [[option.name, option.value] as const] : [],
  ),
)
