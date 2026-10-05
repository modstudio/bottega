type TaskCommandShape = {
  positionalCount: number
  valueFlags: ReadonlySet<string>
  booleanFlags: ReadonlySet<string>
  syntax: string
  help?: string
}

export type ParsedTaskArguments = {
  positionals: string[]
  values: ReadonlyMap<string, string>
  booleans: ReadonlySet<string>
}

export type TaskArgumentResult =
  | { ok: true; arguments: ParsedTaskArguments }
  | { ok: false; refusal: string }

const shape = (
  positionalCount: number,
  syntax: string,
  valueFlags: string[] = [],
  booleanFlags: string[] = [],
  help?: string,
): TaskCommandShape => ({
  positionalCount,
  syntax,
  valueFlags: new Set(valueFlags),
  booleanFlags: new Set(booleanFlags),
  help,
})

const taskCommandShapes = new Map<string, TaskCommandShape>([
  [
    'new',
    shape(
      0,
      'hub task new --project X --title "..." [--status Y] [--parent KEY] [--body "..."|--body-file PATH] [--allow-duplicate "reason"]',
      [
        '--project',
        '--title',
        '--status',
        '--parent',
        '--body',
        '--body-file',
        '--allow-duplicate',
      ],
    ),
  ],
  [
    'duplicates',
    shape(
      0,
      'hub task duplicates --project X --title "..." --json',
      ['--project', '--title'],
      ['--json'],
    ),
  ],
  [
    'tracker-new',
    shape(0, 'hub task tracker-new --project X --title "..." --body "..."', [
      '--project',
      '--title',
      '--body',
    ]),
  ],
  [
    'list',
    shape(
      0,
      'hub task list [--project X] [--status Y] [--parent KEY] [--json]',
      ['--project', '--status', '--parent'],
      ['--json'],
    ),
  ],
  [
    'show',
    shape(
      1,
      'hub task show <KEY> [--project X] [--json] [--fresh]',
      ['--project'],
      ['--json', '--fresh'],
    ),
  ],
  [
    'set',
    shape(
      1,
      'hub task set <KEY> [--project X] [--title "..."] [--status Y] [--parent KEY|--no-parent] [--body "..."] [--assignee NAME] [--force] [--abandon "reason"]',
      ['--project', '--title', '--status', '--parent', '--body', '--assignee', '--abandon'],
      ['--no-parent', '--force'],
    ),
  ],
  [
    'close',
    shape(
      1,
      'hub task close <KEY> [--project X] [--keep-branches] [--abandon "reason"]',
      ['--project', '--abandon'],
      ['--keep-branches'],
    ),
  ],
  ['comment', shape(2, 'hub task comment <KEY> "..." [--project X]', ['--project'])],
  [
    'import',
    shape(1, 'hub task import <file.json>', [], [], 'backfill from a clustered commit history'),
  ],
  [
    'push',
    shape(
      0,
      'hub task push [--dry-run]',
      [],
      ['--dry-run'],
      'migrate and verify the local task cache',
    ),
  ],
  [
    'prune-foreign',
    shape(
      0,
      'hub task prune-foreign [--dry-run] [--confirm N] [--project NAME] [--only-present-elsewhere] [--json]',
      ['--confirm', '--project'],
      ['--dry-run', '--only-present-elsewhere', '--json'],
    ),
  ],
  [
    'doc new',
    shape(
      1,
      'hub task doc new <KEY> [--project X] --title "..." [--role handoff] [--body "..."|--body-file PATH]',
      ['--project', '--title', '--role', '--body', '--body-file'],
    ),
  ],
  [
    'doc list',
    shape(1, 'hub task doc list <KEY> [--project X] [--json]', ['--project'], ['--json']),
  ],
  ['doc show', shape(1, 'hub task doc show <ID> [--json]', [], ['--json'])],
  [
    'doc set',
    shape(
      1,
      'hub task doc set <ID> [--title "..."] [--role handoff|--no-role] [--body "..."|--body-file PATH] [--version TOKEN]',
      ['--title', '--role', '--body', '--body-file', '--version'],
      ['--no-role'],
    ),
  ],
  ['doc rm', shape(1, 'hub task doc rm <ID>')],
])

export type ResolvedTaskCommand = {
  command: string
  shape: TaskCommandShape
  remaining: readonly string[]
}

export function resolveTaskCommand(argv: readonly string[]): ResolvedTaskCommand | undefined {
  const verb = argv[0]
  const canonicalVerb = verb === 'document' ? 'doc' : verb
  const hasAction = canonicalVerb === 'doc'
  const command = hasAction ? `${canonicalVerb} ${argv[1]}` : canonicalVerb
  const commandShape = taskCommandShapes.get(command ?? '')
  if (!commandShape || !command) return undefined
  return { command, shape: commandShape, remaining: argv.slice(hasAction ? 2 : 1) }
}

export const TASK_USAGE = [...taskCommandShapes.values()]
  .map(
    (command) =>
      `hub task ${command.syntax.slice('hub task '.length)}${command.help ? `   ${command.help}` : ''}`,
  )
  .join('\n  ')

const refuse = (
  token: string,
  reason: string,
  command: TaskCommandShape,
): { ok: false; refusal: string } => ({
  ok: false,
  refusal: `${reason}: ${token}\nvalid syntax: ${command.syntax}`,
})

type PositionalResult = { ok: true; positionals: string[] } | { ok: false; refusal: string }

function parsePositionals(argv: readonly string[], command: TaskCommandShape): PositionalResult {
  const positionals: string[] = []
  for (let index = 0; index < command.positionalCount; index += 1) {
    const token = argv[index]
    if (token === undefined) {
      return refuse('<end of arguments>', 'missing positional', command)
    }
    if (token.startsWith('--')) {
      return refuse(token, 'positional cannot start with --', command)
    }
    positionals.push(token)
  }
  return { ok: true, positionals }
}

function parseFlags(
  argv: readonly string[],
  command: TaskCommandShape,
  positionals: string[],
): TaskArgumentResult {
  const values = new Map<string, string>()
  const booleans = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (command.valueFlags.has(token)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        return refuse(token, 'value flag has no value', command)
      }
      if (!values.has(token)) values.set(token, value)
      index += 1
      continue
    }
    if (command.booleanFlags.has(token)) {
      booleans.add(token)
      continue
    }
    if (token.startsWith('--')) return refuse(token, 'unknown flag', command)
    return refuse(token, 'unexpected positional', command)
  }
  return { ok: true, arguments: { positionals, values, booleans } }
}

export function parseTaskArguments(
  argv: readonly string[],
  resolved = resolveTaskCommand(argv),
): TaskArgumentResult | undefined {
  if (!resolved) return undefined
  const positionalResult = parsePositionals(resolved.remaining, resolved.shape)
  if (!positionalResult.ok) return positionalResult
  return parseFlags(
    resolved.remaining.slice(resolved.shape.positionalCount),
    resolved.shape,
    positionalResult.positionals,
  )
}

const isHelpToken = (token: string | undefined) =>
  token === 'help' || token === '--help' || token === '-h'

export function taskHelpRequested(argv: readonly string[]): boolean {
  const verb = argv[0]
  if (isHelpToken(verb)) return true
  const hasAction = verb === 'doc' || verb === 'document'
  const action = hasAction ? argv[1] : undefined
  if (hasAction && isHelpToken(action)) return true
  const resolved = resolveTaskCommand(argv)
  const positionalCount = resolved?.shape.positionalCount ?? 0
  let expectingValue = false
  for (const token of resolved?.remaining.slice(positionalCount) ?? []) {
    if (expectingValue) {
      expectingValue = false
      continue
    }
    if (isHelpToken(token)) return true
    expectingValue = resolved?.shape.valueFlags.has(token) ?? false
  }
  return false
}
