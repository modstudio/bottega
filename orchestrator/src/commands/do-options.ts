// concern: cli
/** The `bottega run start` CLI options, shared with catalogue command validation. */
export const ORCH_DO_OPTIONS = [
  {
    flags: '--agent <value>',
    name: 'agent',
    value: 'required',
    description: 'use this agent instead of routing the run',
  },
  {
    flags: '--avoid <value>',
    name: 'avoid',
    value: 'required',
    description: 'exclude this agent from routing',
  },
  {
    flags: '--distinct-from <value>',
    name: 'distinct-from',
    value: 'required',
    description: 'exclude the model used by this run',
  },
  {
    flags: '--base <value>',
    name: 'base',
    value: 'required',
    description: 'use this revision as the writing run base',
  },
  {
    flags: '--review <value>',
    name: 'review',
    value: 'required',
    description: 'review this run or git revision',
  },
  {
    flags: '--file <value>',
    name: 'file',
    value: 'required',
    description: 'read the prompt from this file',
  },
  {
    flags: '--schema <value>',
    name: 'schema',
    value: 'required',
    description: 'constrain the reply with this JSON schema file',
  },
  {
    flags: '--model <value>',
    name: 'model',
    value: 'required',
    description: 'use this model for the run',
  },
  {
    flags: '--transport <value>',
    name: 'transport',
    value: 'required',
    description: 'use this agent transport',
  },
  {
    flags: '--label <value>',
    name: 'label',
    value: 'required',
    description: 'record this label on the run',
  },
  {
    flags: '--lens <value>',
    name: 'lens',
    value: 'required',
    description: 'apply this review lens',
  },
  {
    flags: '--seed <value>',
    name: 'seed',
    value: 'required',
    description: 'provision the worktree with this project seed',
  },
  {
    flags: '--key <value>',
    name: 'key',
    value: 'required',
    description: 'attribute the run to this task key',
  },
  {
    flags: '--repo <value>',
    name: 'repo',
    value: 'required',
    description: 'run against this registered project',
  },
  {
    flags: '--cwd <value>',
    name: 'cwd',
    value: 'required',
    description: 'resolve the run from this working directory',
  },
  {
    flags: '--deliverable <value>',
    name: 'deliverable',
    value: 'required',
    description: 'require this reader deliverable',
  },
  {
    flags: '--timeout <value>',
    name: 'timeout',
    value: 'required',
    description: 'limit the run to this many minutes',
  },
  { flags: '--carry', description: 'include visible uncommitted checkout changes' },
  { flags: '--quiet', description: 'suppress collection guidance and followed output' },
  { flags: '--probe', description: 'exclude the run from routing evidence' },
  { flags: '--follow', description: 'wait for the detached run and print its result' },
  { flags: '--detach', description: 'return after starting the run' },
  { flags: '--porcelain', description: 'print only the run identifier' },
  { flags: '--no-failover', description: 'disable automatic failover to another agent' },
  {
    flags: '--keep-tree [hours]',
    name: 'keep-tree',
    value: 'optional',
    description: 'keep the run worktree for this many hours after the run',
  },
  {
    flags: '--keep-tree-reason <text>',
    name: 'keep-tree-reason',
    value: 'required',
    description: 'record why the run worktree is kept',
  },
  { flags: '--no-wait-capacity', description: 'refuse instead of waiting for agent capacity' },
  {
    flags: '--mcp [mode]',
    name: 'mcp',
    value: 'optional',
    description: 'require MCP servers, or prefer them with --mcp=prefer',
  },
] as const

export const orchDoValueOptionNames: ReadonlyMap<string, 'required' | 'optional'> = new Map(
  ORCH_DO_OPTIONS.flatMap((option) =>
    'name' in option ? [[option.name, option.value] as const] : [],
  ),
)
