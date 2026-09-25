import { readFileSync } from 'node:fs'
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
  `  orch answer <id> --q<id> "<ruling>"\n` +
  `  orch answer <id> --q<id> --file <path>\n  orch answer <id> --file <path>\n` +
  `  orch answer <id> "<ruling>"`
export const TELL_WORKING_FORMS =
  `  orch tell <id> "<message>"\n` +
  `  orch tell <id> --file <path>\n  orch tell <id> --ping "<message>"\n` +
  `  orch tell <id>  (message on stdin)`
export const CONTINUE_WORKING_FORMS =
  `  orch continue <id> "<what next>"\n` +
  `  orch continue <id> --file <path>\n  orch continue <id>  (message on stdin)`

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
type QuestionTextSource = { id: number; file?: string; text?: string }

export type AnswerTextSources = {
  byId: QuestionTextSource[]
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
  options: { booleans?: Iterable<string>; questions?: boolean; usage?: string } = {},
): AnswerTextSources {
  const usage =
    options.usage ??
    'orch answer <id> ["<ruling>"] [--file PATH] [--q<ID> "<ruling>"] [--q<ID> --file PATH] [--follow]'
  const booleans = new Set(options.booleans ?? [])
  const questions = options.questions ?? false
  const byId: QuestionTextSource[] = []
  let commandFile: string | undefined
  const positionals: string[] = []
  let messageStarted = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (messageStarted) {
      positionals.push(arg)
      continue
    }
    if (questions) {
      const equals = arg.match(/^--q(\d+)=(.*)$/)
      if (equals) {
        byId.push({ id: Number(equals[1]), text: equals[2] })
        continue
      }
      const flagged = arg.match(/^--q(\d+)$/)
      if (flagged) {
        const id = Number(flagged[1])
        const next = args[i + 1]
        if (next === '--file' || next?.startsWith('--file=')) {
          const taken = takeFilePath(args, i + 1, usage)
          byId.push({ id, file: taken.path })
          i = taken.next - 1
          continue
        }
        if (next === undefined || booleans.has(next)) {
          throw new Error(`argument ${arg} needs a value\nworking form: ${usage}`)
        }
        byId.push({ id, text: next })
        i++
        continue
      }
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
  return { byId, commandFile, positionals }
}

export function parseAnswerTextSources(args: string[]): AnswerTextSources {
  return parseWorkerMessageArgs(args, { booleans: ANSWER_BOOLEANS, questions: true })
}

/** Match the bare question selector shared by thin command surfaces. */
export function bareQuestionSelector(arg: string): number | null {
  const match = arg.match(/^--q(\d+)$/)
  return match ? Number(match[1]) : null
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
  'abandon',
  'agent',
  'agents',
  'answer',
  'ask-server',
  'blockers',
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
  'guide',
  'health',
  'inbox',
  'init-db',
  'fix-defect',
  'jobs',
  'judge',
  'lens',
  'mcp',
  'metric',
  'migrate',
  'monitor',
  'note',
  'peek',
  'pending',
  'pick',
  'port',
  'project',
  'record',
  'recalibrate',
  'reclaim',
  'reclassify-failures',
  'reconcile',
  'relay',
  'result',
  'retry',
  'review',
  'routing-backtest',
  'run',
  'runs',
  'score',
  'search',
  'serve',
  'setup-ask',
  'spawns',
  'state',
  'stats',
  'stop',
  'sync',
  'sweep',
  'tell',
  'tree',
  'wait',
  'waiting',
  'workflow',
])

export function isCliCommand(name: string): boolean {
  return CLI_COMMANDS.has(name)
}
