export type TaskCommandShape = {
  positionalCount: number
  valueFlags: ReadonlySet<string>
  booleanFlags: ReadonlySet<string>
  syntax: string
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
): TaskCommandShape => ({
  positionalCount,
  syntax,
  valueFlags: new Set(valueFlags),
  booleanFlags: new Set(booleanFlags),
})

export const taskCommandShapes = new Map<string, TaskCommandShape>([
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
  ['show', shape(1, 'hub task show <KEY> [--project X] [--json]', ['--project'], ['--json'])],
  [
    'set',
    shape(
      1,
      'hub task set <KEY> [--project X] [--title "..."] [--status Y] [--parent KEY|--no-parent] [--body "..."] [--assignee NAME] [--force]',
      ['--project', '--title', '--status', '--parent', '--body', '--assignee'],
      ['--no-parent', '--force'],
    ),
  ],
  [
    'close',
    shape(
      1,
      'hub task close <KEY> [--project X] [--keep-branches]',
      ['--project'],
      ['--keep-branches'],
    ),
  ],
  ['comment', shape(2, 'hub task comment <KEY> "..." [--project X]', ['--project'])],
  ['import', shape(1, 'hub task import <file.json>')],
  ['push', shape(0, 'hub task push [--dry-run]', [], ['--dry-run'])],
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
  [
    'document new',
    shape(
      1,
      'hub task document new <KEY> [--project X] --title "..." [--role handoff] [--body "..."|--body-file PATH]',
      ['--project', '--title', '--role', '--body', '--body-file'],
    ),
  ],
  [
    'document list',
    shape(1, 'hub task document list <KEY> [--project X] [--json]', ['--project'], ['--json']),
  ],
  ['document show', shape(1, 'hub task document show <ID> [--json]', [], ['--json'])],
  [
    'document set',
    shape(
      1,
      'hub task document set <ID> [--title "..."] [--role handoff|--no-role] [--body "..."|--body-file PATH] [--version TOKEN]',
      ['--title', '--role', '--body', '--body-file', '--version'],
      ['--no-role'],
    ),
  ],
  ['document rm', shape(1, 'hub task document rm <ID>')],
])

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
  command: TaskCommandShape,
): TaskArgumentResult {
  const positionalResult = parsePositionals(argv, command)
  if (!positionalResult.ok) return positionalResult
  return parseFlags(argv.slice(command.positionalCount), command, positionalResult.positionals)
}

const isHelpToken = (token: string | undefined) =>
  token === 'help' || token === '--help' || token === '-h'

export function taskHelpRequested(argv: readonly string[]): boolean {
  const verb = argv[1]
  if (isHelpToken(verb)) return true
  const hasAction = verb === 'doc' || verb === 'document'
  const action = hasAction ? argv[2] : undefined
  if (hasAction && isHelpToken(action)) return true
  const command = hasAction ? `${verb} ${action}` : verb
  const positionalStart = hasAction ? 3 : 2
  const commandShape = taskCommandShapes.get(command ?? '')
  const positionalCount = commandShape?.positionalCount ?? 0
  let expectingValue = false
  for (const token of argv.slice(positionalStart + positionalCount)) {
    if (expectingValue) {
      expectingValue = false
      continue
    }
    if (isHelpToken(token)) return true
    expectingValue = commandShape?.valueFlags.has(token) ?? false
  }
  return false
}
