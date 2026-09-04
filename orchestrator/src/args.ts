type CommandShape = {
  usage: string
  maxPositionals: number
  valueFlags?: readonly string[]
  booleanFlags?: readonly string[]
  dynamicValueFlag?: RegExp
  allowedPositionals?: readonly string[]
}

const shape = (
  usage: string,
  maxPositionals: number,
  valueFlags: readonly string[] = [],
  booleanFlags: readonly string[] = [],
  extra: Pick<CommandShape, 'dynamicValueFlag' | 'allowedPositionals'> = {},
): CommandShape => ({ usage, maxPositionals, valueFlags, booleanFlags, ...extra })

const hasArg = (argv: string[], arg: string) => argv.includes(arg)

/** Every word the human-facing CLI understands. */
function commandShape(argv: string[]): { args: string[]; shape: CommandShape } | null {
  const command = argv[0]
  const sub = argv[1]
  switch (command) {
    case 'land': return { args: argv.slice(1), shape: shape(
      'orch land <branch|run-id> | orch land --status', hasArg(argv, '--status') ? 0 : 1,
      [], ['--status'],
    ) }
    case 'contract': return { args: argv.slice(1), shape: shape('orch contract <job>', 1) }
    case 'doc': {
      const forms: Record<string, CommandShape> = {
        list: shape('orch doc list [--scope S] [--subject X] [--json]', 0, ['--scope', '--subject'], ['--json']),
        show: shape('orch doc show <slug> --scope S [--subject X] [--json]', 1, ['--scope', '--subject'], ['--json']),
        set: shape('orch doc set <slug> --scope S [--subject X] --title T (--file F | body on stdin)', 1, ['--scope', '--subject', '--title', '--file'], ['--json']),
        consume: shape('orch doc consume <slug> --scope S [--subject X] [--json]', 1, ['--scope', '--subject'], ['--json']),
        rm: shape('orch doc rm <slug> --scope S [--subject X] [--json]', 1, ['--scope', '--subject'], ['--json']),
        subjects: shape('orch doc subjects [--json]', 0, [], ['--json']),
        export: shape('orch doc export <dir>', 1), import: shape('orch doc import <dir>', 1),
        brief: shape('orch doc brief [--cwd P]', 0, ['--cwd']),
        resumes: shape('orch doc resumes [--cwd P]', 0, ['--cwd']),
      }
      if (!sub || !forms[sub]) return null
      return { args: argv.slice(2), shape: forms[sub] }
    }
    case 'port': {
      const action = argv[2]
      const forms: Record<string, Record<string, CommandShape>> = {
        baseline: {
          show: shape('orch port baseline show <source> <target> [--json]', 2, [], ['--json']),
          set: shape('orch port baseline set <source> <target> <commit> [--json] | --clear', 3, [], ['--clear', '--json']),
        },
        skip: {
          list: shape('orch port skip list <source> <target> [--json]', 2, [], ['--json']),
          add: shape('orch port skip add <source> <target> <candidate> --reason TEXT [--json]', 3, ['--reason'], ['--json']),
        },
        ref: {
          list: shape('orch port ref list [--all] [--json]', 0, [], ['--all', '--json']),
          show: shape('orch port ref show <task-key> [--json]', 1, [], ['--json']),
          set: shape('orch port ref set <task-key> --sources JSON --note TEXT [--json]', 1, ['--sources', '--note'], ['--json']),
          resolve: shape('orch port ref resolve <task-key> [--json]', 1, [], ['--json']),
          'delete-error': shape('orch port ref delete-error <task-key> [--json]', 1, [], ['--json']),
        },
        doctrine: {
          list: shape('orch port doctrine list [--all] [--json]', 0, [], ['--all', '--json']),
          add: shape('orch port doctrine add <number> --title TEXT (--file F | body on stdin) [--json]', 1, ['--title', '--file'], ['--json']),
          retire: shape('orch port doctrine retire <number> [--json]', 1, [], ['--json']),
        },
      }
      if (!sub || !action || !forms[sub]?.[action]) return null
      return { args: argv.slice(3), shape: forms[sub]![action]! }
    }
    case 'mcp': return { args: argv.slice(1), shape: shape('orch mcp [--config]', 0, [], ['--config']) }
    case 'do': return { args: argv.slice(1), shape: shape(
      'orch do <job> [prompt] [--agent NAME] [--file PATH] [--schema PATH] [--model NAME]', Infinity,
      ['--agent', '--avoid', '--distinct-from', '--base', '--file', '--schema', '--model', '--label', '--lens', '--seed', '--key', '--repo'],
      ['--carry', '--mcp', '--quiet', '--probe', '--follow', '--detach', '--porcelain', '--no-failover', '--help'],
    ) }
    case 'review': {
      if (sub === 'record') return { args: argv.slice(2), shape: shape('orch review record <run-id>...', Infinity) }
      if (sub === 'triage') return { args: argv.slice(2), shape: shape(
        'orch review triage <review-id> <finding> <accepted|modified|rejected|skipped> [--category X]', 3,
        ['--category'],
      ) }
      if (sub === 'complete') return { args: argv.slice(2), shape: shape('orch review complete <review-id>', 1) }
      if (sub === 'calibration') return { args: argv.slice(2), shape: shape(
        'orch review calibration <lens> <agent> <model> [--json]', 3, [], ['--json'],
      ) }
      return null
    }
    case 'state': return { args: argv.slice(1), shape: shape('orch state [--days N]', 0, ['--days']) }
    case 'run': return { args: argv.slice(1), shape: shape('orch run <run-id>', 1) }
    case 'search': return { args: argv.slice(1), shape: shape('orch search <file|function|task-key|text> [--limit N] [--full] [--json]', 1, ['--limit'], ['--full', '--json']) }
    case 'result': return { args: argv.slice(1), shape: shape('orch result <run-id> [--quiet]', 1, [], ['--quiet']) }
    case 'wait': return { args: argv.slice(1), shape: shape('orch wait <run-id>... [--timeout SECONDS]', Infinity, ['--timeout']) }
    case 'retry': return { args: argv.slice(1), shape: shape('orch retry <run-id> [--agent NAME] [--follow] [--quiet]', 1, ['--agent'], ['--follow', '--detach', '--quiet']) }
    case 'project': {
      const forms: Record<string, CommandShape> = {
        list: shape('orch project list [--json]', 0, [], ['--json']),
        add: shape('orch project add <path> [--name X] [--stack Y] [--no-canon] [--json]', 1, ['--name', '--stack'], ['--no-canon', '--allow-incomplete', '--json']),
        set: shape('orch project set <name> [--stack X] [--path P] [--canon|--no-canon] [--settings JSON] [--json]', 1, ['--stack', '--path', '--settings'], ['--canon', '--no-canon', '--allow-incomplete', '--json']),
        remove: shape('orch project remove <name>', 1),
      }
      if (!sub || !forms[sub]) return null
      return { args: argv.slice(2), shape: forms[sub] }
    }
    case 'ask-server': return { args: argv.slice(1), shape: shape('orch ask-server', 0) }
    case 'setup-ask': return { args: argv.slice(1), shape: shape('orch setup-ask', 0) }
    case 'blockers': return { args: argv.slice(1), shape: shape('orch blockers [--days N] [--json]', 0, ['--days'], ['--json']) }
    case 'inbox': return { args: argv.slice(1), shape: shape('orch inbox [--all] [--json]', 0, [], ['--all', '--json']) }
    case 'answer': return { args: argv.slice(1), shape: shape(
      'orch answer <id> ["<ruling>"] [--file PATH] [--q<ID> "<ruling>"] [--follow]', Infinity,
      ['--file'], ['--follow', '--detach', '--quiet'], { dynamicValueFlag: /^--q\d+$/ },
    ) }
    case 'tell': return { args: argv.slice(1), shape: shape(
      'orch tell <run-id> ["<message>"] [--file PATH]', Infinity, ['--file'],
    ) }
    case 'continue': return { args: argv.slice(1), shape: shape('orch continue <id> ["<what next>"] [--follow]', 2, [], ['--follow', '--detach', '--quiet']) }
    case 'diff': return { args: argv.slice(1), shape: shape('orch diff <id> [--quiet]', 1, [], ['--quiet']) }
    case 'sweep': return { args: argv.slice(1), shape: shape('orch sweep [--older-than N] [--force] [--dry-run]', 0, ['--older-than'], ['--force', '--dry-run']) }
    case 'discard': return { args: argv.slice(1), shape: shape('orch discard <id> [--force]', 1, [], ['--force']) }
    case 'stop': return { args: argv.slice(1), shape: shape('orch stop <id>', 1) }
    case 'abandon': return { args: argv.slice(1), shape: shape('orch abandon <id> [--note TEXT] [--force]', 1, ['--note'], ['--force']) }
    case 'score': return { args: argv.slice(1), shape: shape(
      'orch score <run-id> <none|partial|full> [wrong|mixed|right] [drifted|partial|faithful] [--note TEXT]',
      4, ['--note', '--better-than', '--scorer'], ['--force', '--void'],
    ) }
    case 'recalibrate': return { args: argv.slice(1), shape: shape('orch recalibrate [--n N] [--scorer WHO] [--force]', 0, ['--n', '--scorer'], ['--force']) }
    case 'runs': return { args: argv.slice(1), shape: shape('orch runs [--job X] [--agent Y] [--limit N] [--unscored] [--since ISO] [--json]', 0, ['--job', '--agent', '--limit', '--since'], ['--unscored', '--json']) }
    case 'guide': return { args: argv.slice(1), shape: shape('orch guide [--job X]', 0, ['--job']) }
    case 'spawns': return { args: argv.slice(1), shape: shape('orch spawns [--limit N]', 0, ['--limit']) }
    case 'stats': return { args: argv.slice(1), shape: shape('orch stats [--job X]', 0, ['--job']) }
    case 'pick': return { args: argv.slice(1), shape: shape('orch pick <job> [--agent NAME] [--avoid NAME] [--distinct-from IDS] [--stack STACK]', 1, ['--agent', '--avoid', '--distinct-from', '--stack']) }
    case 'pending': return { args: argv.slice(1), shape: shape('orch pending', 0) }
    case 'metric': return { args: argv.slice(1), shape: shape('orch metric [collect] [--days N] [--window N]', 1, ['--days', '--window'], [], { allowedPositionals: ['collect'] }) }
    case 'serve': return { args: argv.slice(1), shape: shape('orch serve', 0) }
    case 'reclassify-failures': return { args: argv.slice(1), shape: shape('orch reclassify-failures [--dry-run]', 0, [], ['--dry-run']) }
    case 'doctor': return { args: argv.slice(1), shape: shape('orch doctor [--wake]', 0, [], ['--wake']) }
    case 'jobs': return { args: argv.slice(1), shape: shape('orch jobs', 0) }
    case 'agents': return { args: argv.slice(1), shape: shape('orch agents', 0) }
    default: return null
  }
}

export function validateCliArgs(argv: string[]): void {
  const selected = commandShape(argv)
  if (!selected) return
  const { args, shape: expected } = selected
  const valueFlags = new Set(expected.valueFlags ?? [])
  const booleanFlags = new Set(expected.booleanFlags ?? [])
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const takesValue = valueFlags.has(arg) || Boolean(expected.dynamicValueFlag?.test(arg))
    if (takesValue) {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`argument ${arg} needs a value\nworking form: ${expected.usage}`)
      }
      i++
      continue
    }
    if (booleanFlags.has(arg)) continue
    if (arg.startsWith('--') || positionals.length >= expected.maxPositionals) {
      throw new Error(`unrecognised argument: ${arg}\nworking form: ${expected.usage}`)
    }
    positionals.push(arg)
  }
  const unknown = expected.allowedPositionals
    ? positionals.find((arg) => !expected.allowedPositionals!.includes(arg)) : undefined
  if (unknown) throw new Error(`unrecognised argument: ${unknown}\nworking form: ${expected.usage}`)
}
