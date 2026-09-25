// concern: canon-edit-bash
/** Knows the shell shapes whose write destinations the canon guard can resolve. */
import { isAbsolute } from 'node:path'

export const BASH_WRITE_ESCAPES = [
  'relative targets after cd',
  'command substitutions',
  'interpreter writes',
  'git apply',
  'patch',
] as const

type Token = { text: string; operator: boolean; dynamic: boolean }
type TokenizerState = {
  tokens: Token[]
  text: string
  dynamic: boolean
  heredoc: string | null
  awaitsHeredoc: boolean
}

const SEPARATORS = new Set(['|', '||', '&&', ';', '&', '\n', '(', ')'])
const FILE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>'])
const DISCARD_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '-'])

function commandSubstitution(command: string, start: number): { text: string; end: number } {
  const close = command[start] === '`' ? '`' : ')'
  let index = start + (close === ')' ? 2 : 1)
  let depth = 1
  while (index < command.length) {
    if (command[index] === '\\') {
      index += 2
      continue
    }
    if (close === ')' && command[index] === '(') depth++
    if (command[index] === close && --depth === 0) {
      return { text: command.slice(start, index + 1), end: index + 1 }
    }
    index++
  }
  return { text: command.slice(start), end: command.length }
}

function addText(state: TokenizerState, value: string, dynamic = false): void {
  state.text += value
  state.dynamic ||= dynamic
}

function pushToken(state: TokenizerState): void {
  if (state.text === '') return
  if (state.awaitsHeredoc) {
    state.heredoc = state.text
    state.awaitsHeredoc = false
  }
  state.tokens.push({ text: state.text, operator: false, dynamic: state.dynamic })
  state.text = ''
  state.dynamic = false
}

function pushOperator(state: TokenizerState, value: string): void {
  pushToken(state)
  state.tokens.push({ text: value, operator: true, dynamic: false })
}

function consumeQuote(command: string, start: number, state: TokenizerState): number {
  const quote = command[start]!
  let index = start + 1
  while (index < command.length && command[index] !== quote) {
    if (quote === '"' && command[index] === '\\' && command[index + 1] !== undefined) {
      addText(state, command[index + 1]!)
      index += 2
    } else if (
      quote === '"' &&
      (command[index] === '`' || (command[index] === '$' && command[index + 1] === '('))
    ) {
      const substitution = commandSubstitution(command, index)
      addText(state, substitution.text, true)
      index = substitution.end
    } else addText(state, command[index++]!)
  }
  return index + 1
}

function consumeNewline(command: string, start: number, state: TokenizerState): number {
  pushToken(state)
  let index = start
  if (state.heredoc !== null) {
    const rest = command.slice(index + 1).split('\n')
    let consumed = 0
    while (consumed < rest.length && rest[consumed++]!.trim() !== state.heredoc) {}
    index += rest.slice(0, consumed).join('\n').length + 1
    state.heredoc = null
  }
  pushOperator(state, '\n')
  return index + 1
}

type TokenHandler = (command: string, start: number, state: TokenizerState) => number | null

const handleBackslash: TokenHandler = (command, start, state) => {
  if (command[start] !== '\\') return null
  const next = command[start + 1]
  if (next !== undefined && next !== '\n') addText(state, next)
  return start + 2
}

const handleSubstitution: TokenHandler = (command, start, state) => {
  if (command[start] !== '`' && !(command[start] === '$' && command[start + 1] === '(')) return null
  const substitution = commandSubstitution(command, start)
  addText(state, substitution.text, true)
  return substitution.end
}

const handleQuote: TokenHandler = (command, start, state) =>
  command[start] === "'" || command[start] === '"' ? consumeQuote(command, start, state) : null

const handleWhitespace: TokenHandler = (command, start, state) => {
  if (command[start] !== ' ' && command[start] !== '\t') return null
  pushToken(state)
  return start + 1
}

const handleLess: TokenHandler = (command, start, state) => {
  if (command[start] !== '<') return null
  if (command[start + 1] !== '<') {
    pushOperator(state, '<')
    return start + 1
  }
  pushOperator(state, '<<')
  state.awaitsHeredoc = true
  return start + (command[start + 2] === '-' ? 3 : 2)
}

const handleGreater: TokenHandler = (command, start, state) => {
  if (command[start] !== '>') return null
  if (/^\d+$/.test(state.text)) state.text = ''
  const next = command[start + 1]
  pushOperator(state, next === '>' ? '>>' : next === '|' ? '>|' : next === '&' ? '>&' : '>')
  return start + (next === '>' || next === '|' || next === '&' ? 2 : 1)
}

const handleAmpersand: TokenHandler = (command, start, state) => {
  if (command[start] !== '&') return null
  if (command[start + 1] === '>') {
    const append = command[start + 2] === '>'
    pushOperator(state, append ? '&>>' : '&>')
    return start + (append ? 3 : 2)
  }
  const paired = command[start + 1] === '&'
  pushOperator(state, paired ? '&&' : '&')
  return start + (paired ? 2 : 1)
}

const handleOperator: TokenHandler = (command, start, state) => {
  const character = command[start]!
  if (character === '\n') return consumeNewline(command, start, state)
  if (character === '|') {
    const paired = command[start + 1] === '|'
    pushOperator(state, paired ? '||' : '|')
    return start + (paired ? 2 : 1)
  }
  if (!';()'.includes(character)) return null
  pushOperator(state, character)
  return start + 1
}

const TOKEN_HANDLERS: TokenHandler[] = [
  handleBackslash,
  handleSubstitution,
  handleQuote,
  handleWhitespace,
  handleLess,
  handleGreater,
  handleAmpersand,
  handleOperator,
]

function tokenize(command: string): Token[] {
  const state: TokenizerState = {
    tokens: [],
    text: '',
    dynamic: false,
    heredoc: null,
    awaitsHeredoc: false,
  }
  let index = 0
  while (index < command.length) {
    let next: number | null = null
    for (const handler of TOKEN_HANDLERS) {
      next = handler(command, index, state)
      if (next !== null) break
    }
    if (next === null) addText(state, command[index++]!)
    else index = next
  }
  pushToken(state)
  return state.tokens
}

function invocation(segment: Token[]): { name: string; args: Token[] } {
  const words = segment.filter((token) => !token.operator)
  let head = 0
  while (head < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[head]!.text)) head++
  return { name: words[head]?.text.split('/').at(-1) ?? '', args: words.slice(head + 1) }
}

const option = (token: Token) => token.text.startsWith('-') && token.text !== '-'
const usable = (token: Token | undefined): token is Token =>
  Boolean(
    token &&
      !token.operator &&
      !token.dynamic &&
      token.text !== '' &&
      !DISCARD_TARGETS.has(token.text) &&
      !token.text.startsWith('&'),
  )

function copyTarget(args: Token[], plain: Token[]): Token[] {
  const into = args.find((token) => token.text.startsWith('--target-directory='))
  if (into) return [{ ...into, text: into.text.slice('--target-directory='.length) }]
  const flag = args.findIndex((token) => token.text === '-t' || token.text === '--target-directory')
  if (flag >= 0 && args[flag + 1]) return [args[flag + 1]!]
  return plain.length >= 2 ? [plain.at(-1)!] : []
}

function invocationTargets(name: string, args: Token[]): Token[] {
  const plain = args.filter((token) => !option(token) && token.text !== '')
  if (name === 'tee') return plain
  if (name === 'sed' && args.some((token) => /^--?i/.test(token.text))) {
    return args.some((token) => token.text === '-e' || token.text === '-f') ? plain : plain.slice(1)
  }
  if (name === 'perl') {
    if (!args.some((token) => /^-[^-]*i/.test(token.text) || token.text.startsWith('--in-place')))
      return []
    const skipped = new Set<number>()
    args.forEach((token, index) => {
      if (token.text === '-e' || token.text === '-E') skipped.add(index + 1)
    })
    return args.filter((token, index) => !option(token) && !skipped.has(index))
  }
  if (name === 'dd') {
    return args.flatMap((token) => {
      const output = token.text.match(/^of=(.+)$/)?.[1]
      return output ? [{ ...token, text: output }] : []
    })
  }
  return name === 'cp' || name === 'mv' || name === 'install' ? copyTarget(args, plain) : []
}

function segmentTargets(segment: Token[]): string[] {
  const targets: Token[] = []
  segment.forEach((token, index) => {
    if (token.operator && FILE_REDIRECTS.has(token.text)) targets.push(segment[index + 1]!)
  })
  const call = invocation(segment)
  targets.push(...invocationTargets(call.name, call.args))
  return targets.filter(usable).map((token) => token.text)
}

/** Extract only Bash write targets whose destination the parser can resolve from the repo cwd. */
export function bashWriteTargets(command: string): string[] {
  const targets: string[] = []
  let segment: Token[] = []
  let relativeAfterCd = false
  const flush = () => {
    if (segment.length === 0) return
    const call = invocation(segment)
    if (call.name === 'cd') relativeAfterCd = true
    else {
      for (const target of segmentTargets(segment)) {
        if (isAbsolute(target) || !relativeAfterCd) targets.push(target)
      }
    }
    segment = []
  }
  for (const token of tokenize(command)) {
    if (!token.operator || !SEPARATORS.has(token.text)) segment.push(token)
    else flush()
  }
  flush()
  return [...new Set(targets)]
}
