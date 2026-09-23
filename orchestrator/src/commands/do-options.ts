// concern: cli
/** The value shape of the `orch do` options, shared with catalogue command validation. */
export const ORCH_DO_VALUE_OPTIONS = [
  { name: 'agent', value: 'required' },
  { name: 'avoid', value: 'required' },
  { name: 'distinct-from', value: 'required' },
  { name: 'base', value: 'required' },
  { name: 'review', value: 'required' },
  { name: 'file', value: 'required' },
  { name: 'schema', value: 'required' },
  { name: 'model', value: 'required' },
  { name: 'transport', value: 'required' },
  { name: 'label', value: 'required' },
  { name: 'lens', value: 'required' },
  { name: 'seed', value: 'required' },
  { name: 'key', value: 'required' },
  { name: 'repo', value: 'required' },
  { name: 'cwd', value: 'required' },
  { name: 'deliverable', value: 'required' },
  { name: 'timeout', value: 'required' },
  { name: 'keep-tree-reason', value: 'required', placeholder: 'text' },
  { name: 'keep-tree', value: 'optional', placeholder: 'hours' },
  { name: 'mcp', value: 'optional', placeholder: 'mode' },
] as const

export const orchDoValueOptionNames: ReadonlyMap<string, 'required' | 'optional'> = new Map(
  ORCH_DO_VALUE_OPTIONS.map((option) => [option.name, option.value]),
)
