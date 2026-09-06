import { REVIEW_COVERAGE, REVIEW_LIMITS, REVIEW_OVERLAP, REVIEW_REPRODUCED, REVIEW_SEVERITY } from './db.ts'

const REVIEW_GRADE_USAGE = `[--reproduced ${REVIEW_REPRODUCED.join('|')}] [--coverage ${REVIEW_COVERAGE.join('|')}] [--limits ${REVIEW_LIMITS.join('|')}] [--overlap ${REVIEW_OVERLAP.join('|')}]`

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

export function flagValue(argv: string[], name: string): string | undefined {
  const values = flagValues(argv, name)
  if (values.length > 1) {
    throw new Error(
      `--${name} may be supplied only once; received ${values.map((value) => JSON.stringify(value)).join(' and ')}`,
    )
  }
  return values[0]
}

export function flagValues(argv: string[], name: string): string[] {
  const needle = `--${name}`
  return argv.flatMap((value, index) => {
    if (value === needle) return [argv[index + 1]!]
    if (value.startsWith(`${needle}=`)) return [value.slice(needle.length + 1)]
    return []
  })
}

function shellValue(value: string): string {
  if (!/\s/.test(value)) return value
  return `"${value.replace(/[\\"$`]/g, '\\$&')}"`
}

/** Every documented seed spelling is accepted by the CLI argument parser. */
export function seedGuidance(seeds: string[]): string {
  const forms = seeds.flatMap((seed) => {
    const value = shellValue(seed)
    return [`  --seed ${value}`, `  --seed=${value}`]
  })
  return forms.join('\n') +
    `\nMulti-token seed specs must be quoted as one value, for example:\n` +
    `  --seed "--bundle=catalog --budget-mb=700"\n` +
    `  --seed="--bundle=catalog --budget-mb=700"`
}

/** Every word the human-facing CLI understands. */
export function commandShape(argv: string[], topLevelOnly = false): { args: string[]; shape: CommandShape } | null {
  const command = argv[0]
  const sub = argv[1]
  switch (command) {
    case 'init-db': return { args: argv.slice(1), shape: shape('orch init-db', 0) }
    case 'issue': return { args: argv.slice(1), shape: shape('orch issue <TASK-KEY>', 1) }
    case 'land': return { args: argv.slice(1), shape: shape(
      'orch land <branch|run-id> [--message TEXT] [--file PATH] [--unreviewed REASON] | orch land --status',
      hasArg(argv, '--status') ? 0 : 1,
      ['--message', '--file', '--unreviewed'], ['--status'],
    ) }
    case 'contract': return { args: argv.slice(1), shape: shape('orch contract <job>', 1) }
    case 'doc': {
      if (topLevelOnly) return { args: [], shape: shape('orch doc', 0) }
      const forms: Record<string, CommandShape> = {
        list: shape('orch doc list [--scope S] [--subject X] [--json]', 0, ['--scope', '--subject'], ['--json']),
        show: shape('orch doc show <slug> --scope S [--subject X] [--json]', 1, ['--scope', '--subject'], ['--json']),
        set: shape('orch doc set <slug> --scope S [--subject X] --title T --reason TEXT [--author NAME] [--delivery inject|demand] (--file F | body on stdin) [--json]', 1, ['--scope', '--subject', '--title', '--file', '--reason', '--author', '--delivery'], ['--json']),
        consume: shape('orch doc consume <slug> --scope S [--subject X] [--reason TEXT] [--author NAME] [--json]', 1, ['--scope', '--subject', '--reason', '--author'], ['--json']),
        rm: shape('orch doc rm <slug> --scope S [--subject X] --reason TEXT [--author NAME] [--json]', 1, ['--scope', '--subject', '--reason', '--author'], ['--json']),
        history: shape('orch doc history <scope> <subject|-> <slug> [--json]', 3, [], ['--json']),
        diff: shape('orch doc diff <scope> <subject|-> <slug> [<rev-a> [<rev-b>]]', 5),
        restore: shape('orch doc restore <scope> <subject|-> <slug> <rev> --reason TEXT [--author NAME]', 4, ['--reason', '--author']),
        subjects: shape('orch doc subjects [--json]', 0, [], ['--json']),
        export: shape('orch doc export <dir>', 1), import: shape('orch doc import <dir> --reason TEXT [--author NAME]', 1, ['--reason', '--author']),
        brief: shape('orch doc brief [--cwd P]', 0, ['--cwd']),
        resumes: shape('orch doc resumes [--cwd P]', 0, ['--cwd']),
      }
      if (!sub || !forms[sub]) return null
      return { args: argv.slice(2), shape: forms[sub] }
    }
    case 'canon': {
      if (topLevelOnly) return { args: [], shape: shape('orch canon', 0) }
      const forms: Record<string, CommandShape> = {
        check: shape('orch canon check [--cwd P] [--job J] [--all] [--json]', 0, ['--cwd', '--job'], ['--all', '--json']),
        diff: shape('orch canon diff [--cwd P] [--job J] [--json]', 0, ['--cwd', '--job'], ['--json']),
      }
      if (!sub || !forms[sub]) return null
      return { args: argv.slice(2), shape: forms[sub] }
    }
    case 'port': {
      if (topLevelOnly) return { args: [], shape: shape('orch port', 0) }
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
    case 'workflow': {
      const forms: Record<string, CommandShape> = {
        list: shape('orch workflow list [--json]', 0, [], ['--json']),
        show: shape('orch workflow show <slug> [--version N] [--json]', 1, ['--version'], ['--json']),
        set: shape('orch workflow set <slug> --file PATH --reason TEXT [--author NAME]', 1, ['--file','--reason','--author']),
        promote: shape('orch workflow promote <slug> <n> --reason TEXT [--author NAME]', 2, ['--reason','--author']),
        retire: shape('orch workflow retire <slug> <n> --reason TEXT [--author NAME]', 2, ['--reason','--author']),
        fork: shape('orch workflow fork <slug> [--from N] --reason TEXT [--author NAME]', 1, ['--from','--reason','--author']),
        versions: shape('orch workflow versions <slug> [--json]', 1, [], ['--json']),
        compose: shape('orch workflow compose <slug> [--mode M] [--arg k=v]... [--json]', 1, ['--mode','--arg'], ['--json']),
        step: shape('orch workflow step <slug> <step-slug> [--arg k=v]... [--json]', 2, ['--arg'], ['--json']),
        export: shape('orch workflow export <dir>', 1),
        import: shape('orch workflow import <dir> --reason TEXT [--author NAME]', 1, ['--reason','--author']),
      }
      if (!sub || !forms[sub]) return null
      return { args: argv.slice(2), shape: forms[sub]! }
    }
    case 'do': return { args: argv.slice(1), shape: shape(
      'orch do <job> [prompt] [--agent NAME] [--file PATH] [--schema PATH] [--model NAME]', Infinity,
      ['--agent', '--avoid', '--distinct-from', '--base', '--file', '--schema', '--model', '--label', '--lens', '--seed', '--key', '--repo', '--cwd'],
      ['--carry', '--mcp', '--quiet', '--probe', '--follow', '--detach', '--porcelain', '--no-failover', '--help'],
    ) }
    case 'review': {
      if (topLevelOnly) return { args: [], shape: shape('orch review', 0) }
      if (sub === 'record') return { args: argv.slice(2), shape: shape('orch review record <run-id>...', Infinity) }
      if (sub === 'triage') return { args: argv.slice(2), shape: shape(
        `orch review triage <review-id> <finding> <accepted|modified|rejected|skipped> [--category X] [--severity ${REVIEW_SEVERITY.join('|')}]`, 3,
        ['--category', '--severity'],
      ) }
      if (sub === 'complete') return { args: argv.slice(2), shape: shape('orch review complete <review-id>', 1) }
      if (sub === 'pins') return { args: argv.slice(2), shape: shape('orch review pins [--prune]', 0, [], ['--prune']) }
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
      if (topLevelOnly) return { args: [], shape: shape('orch project', 0) }
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
    case 'monitor': return { args: argv.slice(1), shape: shape(
      'orch monitor [--backstop|--history] [--limit N] [--json]', 0, ['--limit'],
      ['--backstop', '--history', '--json'],
    ) }
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
      `orch score <run-id> <none|partial|full> [wrong|mixed|right] [drifted|partial|faithful] [--note TEXT] ${REVIEW_GRADE_USAGE}`,
      4, ['--note', '--better-than', '--scorer', '--reproduced', '--coverage', '--limits', '--overlap'], ['--force', '--void'],
    ) }
    case 'recalibrate': return { args: argv.slice(1), shape: shape('orch recalibrate [--n N] [--scorer WHO] [--force]', 0, ['--n', '--scorer'], ['--force']) }
    case 'runs': return { args: argv.slice(1), shape: shape('orch runs [--id ID]... [--job X] [--agent Y] [--limit N] [--unscored] [--since ISO] [--json]', 0, ['--id', '--job', '--agent', '--limit', '--since'], ['--unscored', '--json']) }
    case 'guide': return { args: argv.slice(1), shape: shape(
      'orch guide [--job X] [--prompt-bytes N]', 0, ['--job', '--prompt-bytes'],
    ) }
    case 'spawns': return { args: argv.slice(1), shape: shape('orch spawns [--limit N]', 0, ['--limit']) }
    case 'stats': return { args: argv.slice(1), shape: shape('orch stats [--job X]', 0, ['--job']) }
    case 'pick': return { args: argv.slice(1), shape: shape('orch pick <job> [--agent NAME] [--avoid NAME] [--distinct-from IDS] [--stack STACK]', 1, ['--agent', '--avoid', '--distinct-from', '--stack']) }
    case 'pending': return { args: argv.slice(1), shape: shape('orch pending', 0) }
    case 'metric': return { args: argv.slice(1), shape: shape('orch metric [collect] [--days N] [--window N]', 1, ['--days', '--window'], [], { allowedPositionals: ['collect'] }) }
    case 'serve': return { args: argv.slice(1), shape: shape('orch serve', 0) }
    case 'reclassify-failures': return { args: argv.slice(1), shape: shape('orch reclassify-failures [--dry-run]', 0, [], ['--dry-run']) }
    case 'doctor': return { args: argv.slice(1), shape: shape('orch doctor [--wake]', 0, [], ['--wake']) }
    case 'jobs': return { args: argv.slice(1), shape: shape('orch jobs [--json]', 0, [], ['--json']) }
    case 'agents': return { args: argv.slice(1), shape: shape('orch agents [--json]', 0, [], ['--json']) }
    default: return null
  }
}

/** Ask the parser itself whether a top-level word has any accepted command shape. */
export function isCliCommand(name: string): boolean {
  return commandShape([name], true) !== null
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
    const equals = arg.indexOf('=')
    const flagName = equals >= 0 ? arg.slice(0, equals) : arg
    const takesValue = valueFlags.has(flagName) || Boolean(expected.dynamicValueFlag?.test(flagName))
    if (takesValue) {
      if (equals >= 0) {
        if (equals === arg.length - 1) {
          throw new Error(`argument ${flagName} needs a value\nworking form: ${expected.usage}`)
        }
        continue
      }
      const value = args[i + 1]
      if (value === undefined) {
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
