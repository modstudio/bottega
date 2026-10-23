import { readFileSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  ANSWER_CHANNEL_CLI,
  ANSWER_CHANNEL_VALUES,
  type AnswerChannel,
} from '../../../shared/question-vocabulary.ts'

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

export const ANSWER_WORKING_FORMS =
  `  ${PLATFORM_SLUG} question answer <id> --q<id> "<ruling>"\n` +
  `  ${PLATFORM_SLUG} question answer <id> --q<id> "<ruling>" --from-operator-q<id>\n` +
  `  ${PLATFORM_SLUG} question answer <id> --q<id> --file <path>\n  ${PLATFORM_SLUG} question answer <id> --file <path>\n` +
  `  ${PLATFORM_SLUG} question answer <id> "<ruling>"`
export const TELL_WORKING_FORMS =
  `  ${PLATFORM_SLUG} run tell <id> "<message>"\n` +
  `  ${PLATFORM_SLUG} run tell <id> --file <path>\n  ${PLATFORM_SLUG} run tell <id> --ping "<message>"\n` +
  `  ${PLATFORM_SLUG} run tell <id>  (message on stdin)`
export const CONTINUE_WORKING_FORMS =
  `  ${PLATFORM_SLUG} run continue <id> "<what next>"\n` +
  `  ${PLATFORM_SLUG} run continue <id> --file <path>\n  ${PLATFORM_SLUG} run continue <id>  (message on stdin)`

/** Empty, whitespace-only, or a single token beginning with `--` is a misparse. */
export function misparsedMessage(text: string): 'empty' | 'dash-token' | null {
  const trimmed = text.trim()
  if (!trimmed) return 'empty'
  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 1 && tokens[0]!.startsWith('--')) return 'dash-token'
  return null
}

export function refuseMisparsedMessage(text: string, noun: string, workingForms: string): void {
  const kind = misparsedMessage(text)
  if (kind === 'empty') {
    throw new Error(
      `empty ${noun}: received ${JSON.stringify(text)}\nworking forms:\n${workingForms}`,
    )
  }
  if (kind === 'dash-token') {
    throw new Error(
      `received ${JSON.stringify(text)} as a ${noun}; a single token beginning with -- is a misparse, not a decision\n` +
        `working forms:\n${workingForms}`,
    )
  }
}

/** First invalid UTF-8 byte offset, or null if the buffer is well-formed. */
export function invalidUtf8Offset(bytes: Uint8Array): number | null {
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]!
    const rest = bytes.length - i
    const fail = (offset = i) => offset
    const cont = (n: number) => {
      for (let k = 1; k <= n; k++) {
        if ((bytes[i + k]! & 0xc0) !== 0x80) return false
      }
      return true
    }
    if (b <= 0x7f) {
      i += 1
      continue
    }
    if (b >= 0xc2 && b <= 0xdf) {
      if (rest < 2 || !cont(1)) return fail()
      i += 2
      continue
    }
    if (b === 0xe0) {
      if (rest < 3 || bytes[i + 1]! < 0xa0 || bytes[i + 1]! > 0xbf || !cont(2)) return fail()
      i += 3
      continue
    }
    if (b >= 0xe1 && b <= 0xec) {
      if (rest < 3 || !cont(2)) return fail()
      i += 3
      continue
    }
    if (b === 0xed) {
      if (rest < 3 || bytes[i + 1]! < 0x80 || bytes[i + 1]! > 0x9f || !cont(2)) return fail()
      i += 3
      continue
    }
    if (b === 0xee || b === 0xef) {
      if (rest < 3 || !cont(2)) return fail()
      i += 3
      continue
    }
    if (b === 0xf0) {
      if (rest < 4 || bytes[i + 1]! < 0x90 || bytes[i + 1]! > 0xbf || !cont(3)) return fail()
      i += 4
      continue
    }
    if (b >= 0xf1 && b <= 0xf3) {
      if (rest < 4 || !cont(3)) return fail()
      i += 4
      continue
    }
    if (b === 0xf4) {
      if (rest < 4 || bytes[i + 1]! < 0x80 || bytes[i + 1]! > 0x8f || !cont(3)) return fail()
      i += 4
      continue
    }
    return fail()
  }
  return null
}

function nulByteOffset(text: string): number | null {
  const at = text.indexOf('\0')
  return at < 0 ? null : Buffer.byteLength(text.slice(0, at), 'utf8')
}
function decodeWorkerBytes(bytes: Uint8Array, source: string): string {
  const at = invalidUtf8Offset(bytes)
  if (at !== null) throw new Error(`invalid UTF-8 in ${source} at byte offset ${at}`)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
export function readWorkerFile(path: string): string {
  return decodeWorkerBytes(readFileSync(path), path)
}
export function assertWorkerText(text: string, noun: string, forms: string, limit?: number): void {
  refuseMisparsedMessage(text, noun, forms)
  const nul = nulByteOffset(text)
  if (nul !== null)
    throw new Error(`${noun} contains a NUL at byte offset ${nul}\nworking forms:\n${forms}`)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (limit !== undefined && bytes > limit)
    throw new Error(
      `${noun} is ${bytes} bytes; this agent's resume transport is bounded at ${limit} bytes\nworking forms:\n${forms}`,
    )
}
type MessageTextOptions = {
  missing: string
  exclusive?: string
  optional?: boolean
  sources: { commandFile?: string; positionals: string[] }
}
export async function readMessageText(
  opts: MessageTextOptions,
  stdin: { isTTY?: boolean; bytes(): Promise<Uint8Array> } = Bun.stdin,
): Promise<string | undefined> {
  const commandFile = opts.sources.commandFile
  const positional = opts.sources.positionals
  if (commandFile && positional.length && opts.exclusive) throw new Error(opts.exclusive)
  if (commandFile) return readWorkerFile(commandFile)
  if (positional.length) return positional.join(' ')
  if (!stdin.isTTY) return decodeWorkerBytes(new Uint8Array(await stdin.bytes()), 'stdin')
  if (opts.optional) return undefined
  throw new Error(opts.missing)
}
type QuestionTextSource = { identifier: string; file?: string; text?: string }
type QuestionSelector = { identifier: string; text?: string }

export type AnswerTextSources = {
  byId: QuestionTextSource[]
  fromOperatorIds?: string[]
  commandFile: string | undefined
  positionals: string[]
}

function takeFilePath(
  args: string[],
  index: number,
  usage: string,
): { path: string; next: number } {
  const arg = args[index]!
  if (arg.startsWith('--file=')) {
    const path = arg.slice('--file='.length)
    if (!path) throw new Error(`argument --file needs a value\nworking form: ${usage}`)
    return { path, next: index + 1 }
  }
  const path = args[index + 1]
  if (path === undefined) throw new Error(`argument --file needs a value\nworking form: ${usage}`)
  return { path, next: index + 2 }
}

function questionSelector(arg: string): QuestionSelector | null {
  const equals = arg.match(/^--q([^=]+)=(.*)$/)
  if (equals) return { identifier: equals[1]!, text: equals[2]! }
  const flagged = arg.match(/^--q(.+)$/)
  return flagged ? { identifier: flagged[1]! } : null
}

function questionTextSource(
  args: string[],
  index: number,
  selector: QuestionSelector,
  booleans: Set<string>,
  usage: string,
): { source: QuestionTextSource; next: number } {
  if ('text' in selector) return { source: selector, next: index + 1 }
  const next = args[index + 1]
  if (next === '--file' || next?.startsWith('--file=')) {
    const taken = takeFilePath(args, index + 1, usage)
    return { source: { identifier: selector.identifier, file: taken.path }, next: taken.next }
  }
  if (next === undefined || booleans.has(next)) {
    throw new Error(`argument ${args[index]} needs a value\nworking form: ${usage}`)
  }
  return { source: { identifier: selector.identifier, text: next }, next: index + 2 }
}

const QUESTION_OPERATOR_FLAG_PREFIX = '--from-operator-q'

export function questionOperatorFlag(identifier: string): string {
  return `${QUESTION_OPERATOR_FLAG_PREFIX}${identifier}`
}

function operatorQuestionIdentifier(arg: string, enabled: boolean): string | null {
  if (!enabled || !arg.startsWith(QUESTION_OPERATOR_FLAG_PREFIX)) return null
  const identifier = arg.slice(QUESTION_OPERATOR_FLAG_PREFIX.length)
  if (!identifier) throw new Error(`${questionOperatorFlag('<id>')} needs a question identifier`)
  return identifier
}

/**
 * Walk argv after the run id. `--q<id>` / `--file` / command booleans are
 * recognized only before the first positional message word; after that every
 * remaining word is message text, including flag-shaped ones.
 */
const ANSWER_BOOLEANS = new Set([
  '--follow',
  '--detach',
  '--quiet',
  '--record-only',
  '--from-operator',
  '--json',
])

export function parseAnswerChannelArgs(args: string[]): {
  argv: string[]
  channel: AnswerChannel
} {
  const argv: string[] = []
  let channel: string = ANSWER_CHANNEL_CLI
  let seen = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg !== '--channel' && !arg.startsWith('--channel=')) {
      argv.push(arg)
      continue
    }
    if (seen) throw new Error('--channel may be supplied only once')
    seen = true
    channel = arg === '--channel' ? (args[++index] ?? '') : arg.slice('--channel='.length)
    if (!ANSWER_CHANNEL_VALUES.includes(channel as AnswerChannel)) {
      throw new Error(`--channel must be one of: ${ANSWER_CHANNEL_VALUES.join(', ')}`)
    }
  }
  return { argv, channel: channel as AnswerChannel }
}

export function parseWorkerMessageArgs(
  args: string[],
  options: {
    booleans?: Iterable<string>
    questions?: boolean
    questionOperatorFlags?: boolean
    usage?: string
  } = {},
): AnswerTextSources {
  const usage =
    options.usage ??
    `${PLATFORM_SLUG} question answer <id> ["<ruling>"] [--file PATH] [--q<ID> "<ruling>"] [--q<ID> --file PATH] [--follow]`
  const booleans = new Set(options.booleans ?? [])
  const questions = options.questions ?? false
  const byId: QuestionTextSource[] = []
  const fromOperatorIds: string[] = []
  let commandFile: string | undefined
  const positionals: string[] = []
  let messageStarted = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (messageStarted) {
      positionals.push(arg)
      continue
    }
    const operatorIdentifier = operatorQuestionIdentifier(
      arg,
      options.questionOperatorFlags ?? false,
    )
    if (operatorIdentifier !== null) {
      fromOperatorIds.push(operatorIdentifier)
      continue
    }
    const selector = questions && !booleans.has(arg) ? questionSelector(arg) : null
    if (selector) {
      const taken = questionTextSource(args, i, selector, booleans, usage)
      byId.push(taken.source)
      i = taken.next - 1
      continue
    }
    if (arg === '--file' || arg.startsWith('--file=')) {
      const taken = takeFilePath(args, i, usage)
      commandFile = taken.path
      i = taken.next - 1
      continue
    }
    if (booleans.has(arg)) continue
    messageStarted = true
    positionals.push(arg)
  }
  return {
    byId,
    ...(options.questionOperatorFlags ? { fromOperatorIds } : {}),
    commandFile,
    positionals,
  }
}

export type ContinueArgs = {
  identifier: string
  sources: { commandFile?: string; positionals: string[] }
}

/** Parse continue independently of Commander's option ordering and positional assignment. */
export function parseContinueArgs(args: string[], usage: string): ContinueArgs {
  const booleans = new Set(['--follow', '--detach', '--quiet', '--findings'])
  const positionals: string[] = []
  let commandFile: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (booleans.has(arg)) continue
    if (arg === '--file' || arg.startsWith('--file=')) {
      if (commandFile !== undefined)
        throw new Error(`--file may be supplied only once\nworking form: ${usage}`)
      const taken = takeFilePath(args, index, usage)
      commandFile = taken.path
      index = taken.next - 1
      continue
    }
    if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\nworking form: ${usage}`)
    positionals.push(arg)
  }
  const identifier = positionals.shift()
  if (!identifier) throw new Error(`exactly one run id is required\nworking form: ${usage}`)
  if (commandFile !== undefined && positionals.length) {
    throw new Error(
      `unexpected positional arguments with --file: ${positionals.join(' ')}\nworking form: ${usage}`,
    )
  }
  return { identifier, sources: { commandFile, positionals } }
}

export function parseAnswerTextSources(args: string[]): AnswerTextSources {
  return parseWorkerMessageArgs(args, {
    booleans: ANSWER_BOOLEANS,
    questions: true,
    questionOperatorFlags: true,
  })
}

/** Match the bare question selector shared by thin command surfaces; the caller resolves the identifier. */
export function bareQuestionSelector(arg: string): string | null {
  const match = arg.match(/^--q([^=]+)$/)
  return match ? match[1]! : null
}

/** Every documented seed spelling is accepted by the CLI argument parser. */
export function seedGuidance(seeds: string[]): string {
  const forms = seeds.flatMap((seed) => {
    const value = shellValue(seed)
    return [`  --seed ${value}`, `  --seed=${value}`]
  })
  return (
    forms.join('\n') +
    `\nMulti-token seed specs must be quoted as one value, for example:\n` +
    `  --seed "--bundle=catalog --budget-mb=700"\n` +
    `  --seed="--bundle=catalog --budget-mb=700"`
  )
}

export const CLI_COMMANDS = new Set([
  'ratchet',
  'abandon',
  'agent',
  'agents',
  'answer',
  'ask-server',
  'mcp-reader-proxy',
  'blockers',
  'board',
  'branches',
  'canon',
  'check',
  'close-out',
  'code',
  'config',
  'confinement',
  'continue',
  'context',
  'contract',
  'diff',
  'discard',
  'do',
  'doc',
  'doctor',
  'epic',
  'enforcement',
  'efficiency',
  'guide',
  'health',
  'hub-import',
  'inbox',
  'init-db',
  'fix-defect',
  'gate',
  'jobs',
  'lens',
  'mcp',
  'metric',
  'migrate',
  'monitor',
  'peek',
  'pending',
  'pick',
  'port',
  'pr',
  'project',
  'provisioning',
  'question',
  'record',
  'reference',
  'recalibrate',
  'reclaim',
  'reclassify-failures',
  'reconcile',
  'relay',
  'release',
  'result',
  'retry',
  'review',
  'routing-backtest',
  'run',
  'run-identities',
  'question-identities',
  'ruling',
  'runs',
  'score',
  'session',
  'search',
  'subject',
  'settings',
  'setup',
  'setup-ask',
  'spawns',
  'state',
  'stats',
  'storage',
  'stop',
  'sync',
  'sweep',
  'tell',
  'test-substance',
  'tree',
  'wait',
  'waiting',
  'workflow',
])

export function isCliCommand(name: string): boolean {
  return CLI_COMMANDS.has(name)
}
