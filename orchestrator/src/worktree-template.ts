// concern: worktree-template
/**
 * Knows worktree template grammar, placeholders, validation, migration, and
 * recipe argv expansion. Must not know databases, run state, routing,
 * transports, or worktree lifecycle.
 */
/**
 * One argument in a project's create command.
 *
 * A string is always passed, including when one of its placeholders is empty.
 * The other two forms make the exceptional behaviours visible at the argument
 * that requests them: omission names the empty value that removes the argument,
 * and expansion is the one deliberate boundary where a seed string becomes
 * several argv entries.
 */
export type WorktreeCreateArg =
  | string
  | {
      value: string
      omitWhenEmpty: 'branch' | 'name' | 'base' | 'seed' | 'key' | 'path'
    }
  | {
      expand: 'seed'
    }

export type WorktreeCreate =
  | {
      command: string
      args: WorktreeCreateArg[]
      env?: Record<string, string>
    }
  | {
      /**
       * Narrow escape hatch for the one lifecycle tool whose input is piped JSON.
       * Registration refuses this form unless it contains a real pipeline; an
       * ordinary command must use command plus args.
       */
      pipeline: string
    }

const CREATE_VARS = new Set(['branch', 'name', 'base', 'seed', 'key', 'path'])

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!)
}

function hasPipelineOperator(template: string): boolean {
  return scanPipelineOperators(template).positions.length > 0
}

function scanPipelineOperators(template: string): {
  positions: number[]
  ands: number[]
  unclosed: { quote: "'" | '"'; position: number } | null
} {
  const positions: number[] = []
  const ands: number[] = []
  let quote: "'" | '"' | null = null
  let quoteStart = 0
  for (let i = 0; i < template.length; i++) {
    const char = template[i]
    if (char === '\\' && quote !== "'") {
      i++
    } else if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'"
      if (quote) quoteStart = i
    } else if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"'
      if (quote) quoteStart = i
    } else if (
      char === '|' &&
      quote === null &&
      template[i - 1] !== '|' &&
      template[i + 1] !== '|'
    ) {
      positions.push(i)
    } else if (char === '&' && quote === null && template[i + 1] === '&') {
      ands.push(i)
      i++
    }
  }
  return {
    positions,
    ands,
    unclosed: quote ? { quote, position: quoteStart } : null,
  }
}

function validateCreate(create: unknown, at: string, allowedVars: Set<string>): string[] {
  if (create === undefined) return []
  if (typeof create === 'string') {
    return [`${at} is a shell string; migrate it (DEV-308)`]
  }
  if (!create || typeof create !== 'object' || Array.isArray(create)) {
    return [`${at} must be an object with command and args`]
  }
  const value = create as Record<string, unknown>
  if ('pipeline' in value) {
    if (
      Object.keys(value).length !== 1 ||
      typeof value.pipeline !== 'string' ||
      !value.pipeline.trim()
    ) {
      return [`${at}.pipeline must be the declaration's only key and must be a non-empty string`]
    }
    if (!hasPipelineOperator(value.pipeline)) {
      return [`${at}.pipeline is only for a command that uses a pipe; use command and args`]
    }
    const unknown = placeholders(value.pipeline).find((name) => !allowedVars.has(name))
    if (unknown) return [`${at}.pipeline contains unknown placeholder {${unknown}}`]
    const capability = placeholders(value.pipeline).find(
      (name) => name === 'base' || name === 'seed',
    )
    return capability
      ? [`${at}.pipeline cannot declare {${capability}} semantics; use command and args`]
      : []
  }
  const problems: string[] = []
  if (typeof value.command !== 'string' || !value.command.trim()) {
    problems.push(`${at}.command must be a non-empty string`)
  } else if (/\s/.test(value.command)) {
    problems.push(`${at}.command must name one executable; put each argument in args`)
  } else if (
    /(^|\/)(?:ba|z|da)?sh$/.test(value.command) &&
    Array.isArray(value.args) &&
    value.args.includes('-c')
  ) {
    problems.push(
      `${at} may not disguise a shell string as ${value.command} -c; use command and args`,
    )
  }
  if (!Array.isArray(value.args)) {
    problems.push(`${at}.args must be an array`)
    return problems
  }
  if (Object.keys(value).some((key) => key !== 'command' && key !== 'args' && key !== 'env')) {
    problems.push(`${at} may contain only command, args, and env`)
  }
  if (value.env !== undefined) {
    if (!value.env || typeof value.env !== 'object' || Array.isArray(value.env)) {
      problems.push(`${at}.env must be an object mapping names to string values`)
    } else {
      for (const [name, envValue] of Object.entries(value.env as Record<string, unknown>)) {
        const envAt = `${at}.env.${name}`
        if (typeof envValue !== 'string') {
          problems.push(`${envAt} must be a string`)
          continue
        }
        const unknown = placeholders(envValue).find((variable) => !CREATE_VARS.has(variable))
        if (unknown) problems.push(`${envAt} contains unknown placeholder {${unknown}}`)
      }
    }
  }
  value.args.forEach((arg, index) => {
    const argAt = `${at}.args[${index}]`
    if (typeof arg === 'string') {
      const unknown = placeholders(arg).find((name) => !allowedVars.has(name))
      if (unknown) problems.push(`${argAt} contains unknown placeholder {${unknown}}`)
      return
    }
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
      problems.push(`${argAt} must be a string, omit-when-empty argument, or seed expansion`)
      return
    }
    const item = arg as Record<string, unknown>
    if ('expand' in item) {
      if (Object.keys(item).length !== 1 || item.expand !== 'seed') {
        problems.push(`${argAt}.expand must be exactly "seed"`)
      }
      return
    }
    const variable = item.omitWhenEmpty
    if (
      Object.keys(item).some((key) => key !== 'value' && key !== 'omitWhenEmpty') ||
      typeof item.value !== 'string' ||
      typeof variable !== 'string' ||
      !allowedVars.has(variable)
    ) {
      problems.push(`${argAt} must have a string value and one valid omitWhenEmpty variable`)
      return
    }
    if (!placeholders(item.value).includes(variable)) {
      problems.push(`${argAt}.value must contain {${variable}}, the value named by omitWhenEmpty`)
    }
    const unknown = placeholders(item.value).find((name) => !allowedVars.has(name))
    if (unknown) problems.push(`${argAt}.value contains unknown placeholder {${unknown}}`)
  })
  return problems
}

export type CreateMigration =
  | { kind: 'migrated'; after: WorktreeCreate }
  | { kind: 'refused'; message: string }

/** Convert the legacy shell subset represented by the live project register. */
export function migrateCreate(create: string): CreateMigration {
  const pipeline = scanPipelineOperators(create)
  if (pipeline.unclosed) {
    return {
      kind: 'refused',
      message: unsupportedShellToken(
        pipeline.unclosed.quote,
        pipeline.unclosed.position,
        'unclosed quote',
      ).message,
    }
  }
  const pipes = pipeline.positions
  if (pipes.length) {
    if (pipes.length !== 1) {
      return { kind: 'refused', message: 'only a single pipe can be migrated' }
    }
    const capability = placeholders(create).find((name) => name === 'seed' || name === 'base')
    if (capability) {
      return {
        kind: 'refused',
        message: `a pipe using {${capability}} cannot be migrated; the pipe must move into the project's script`,
      }
    }
    return { kind: 'migrated', after: { pipeline: create } }
  }

  const and = pipeline.ands[0]
  if (and !== undefined) {
    const before = shellTokens(create.slice(0, and))
    if (!before.ok) return { kind: 'refused', message: before.message }
    return {
      kind: 'refused',
      message:
        `'&&'-chained tail ${JSON.stringify(create.slice(and + 2).trim())} cannot be migrated; ` +
        `the chain must move into the project's script`,
    }
  }
  const parsed = shellTokens(create)
  if (!parsed.ok) return { kind: 'refused', message: parsed.message }
  const tokens = parsed.tokens

  const env: Record<string, string> = {}
  while (tokens.length) {
    const match = tokens[0]!.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s)
    if (!match) break
    env[match[1]!] = match[2]!
    tokens.shift()
  }
  const command = tokens.shift()
  if (!command) return { kind: 'refused', message: 'create string has no command to migrate' }
  return {
    kind: 'migrated',
    after: { command, args: tokens, ...(Object.keys(env).length ? { env } : {}) },
  }
}

type ShellTokens = { ok: true; tokens: string[] } | { ok: false; message: string }

/** Plain shell words plus &&; unsupported shell semantics fail at their first offset. */
function shellTokens(input: string): ShellTokens {
  const tokens: string[] = []
  let token = ''
  let started = false
  let quote: "'" | '"' | null = null
  let quoteStart = 0
  const push = () => {
    if (!started) return
    tokens.push(token)
    token = ''
    started = false
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (quote) {
      if (char === quote) {
        quote = null
      } else if (quote !== "'" && char === '\\') {
        return unsupportedShellToken('\\', i)
      } else if (quote !== "'" && char === '$') {
        return unsupportedShellToken('$', i)
      } else if (quote !== "'" && char === '`') {
        return unsupportedShellToken('`', i)
      } else {
        token += char
      }
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      quoteStart = i
      started = true
      continue
    }
    if (char === ' ' || char === '\t') {
      push()
      continue
    }
    if (char === '&' && input[i + 1] === '&') {
      push()
      tokens.push('&&')
      i++
      continue
    }
    if (char === '{') {
      const placeholder = input.slice(i).match(/^\{[A-Za-z_][A-Za-z0-9_]*\}/)?.[0]
      if (!placeholder) return unsupportedShellToken(char, i)
      token += placeholder
      started = true
      i += placeholder.length - 1
      continue
    }
    if (/[A-Za-z0-9_\-./:=@,+%]/.test(char)) {
      token += char
      started = true
      continue
    }
    return unsupportedShellToken(char, i)
  }
  if (quote) return unsupportedShellToken(quote, quoteStart, 'unclosed quote')
  push()
  return { ok: true, tokens }
}

function unsupportedShellToken(
  token: string,
  position: number,
  kind = 'unsupported shell token',
): { ok: false; message: string } {
  return {
    ok: false,
    message: `${kind} ${JSON.stringify(token)} at position ${position}; cannot migrate`,
  }
}

function fillArg(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_placeholder, key: string) => vars[key] ?? '')
}

/** Render the declared process argv. Empty strings remain real argv entries. */
export function createArgv(
  stored: WorktreeCreate | string,
  vars: Record<string, string>,
): string[] {
  // TOLERANT READ, STRICT WRITE. A legacy row becomes the equivalent shell
  // declaration in memory; validateProjectSettings still refuses anyone
  // trying to register that row shape again. This is a migration ramp, not a
  // permanent format: remove it once every authoritative `project list --json`
  // reports zero string-valued worktree.create declarations.
  const create: WorktreeCreate = typeof stored === 'string' ? { pipeline: stored } : stored
  if ('pipeline' in create) return ['sh', '-c', fillTool(create.pipeline, vars)]
  const args: string[] = []
  for (const arg of create.args) {
    if (typeof arg === 'string') {
      args.push(fillArg(arg, vars))
    } else if ('expand' in arg) {
      // The only call to shellWords: splitting is possible only when the
      // declaration visibly selects the explicit seed-expansion argument.
      args.push(...expandedSeed(vars[arg.expand] ?? ''))
    } else if (vars[arg.omitWhenEmpty]) {
      args.push(fillArg(arg.value, vars))
    }
  }
  return [create.command, ...args]
}

function assertCreateVarsAvailable(
  create: WorktreeCreate | string,
  vars: Record<string, string>,
): void {
  const encoded = JSON.stringify(create)
  const missing = [...encoded.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1]!)
    .find((name) => !(name in vars))
  if (missing)
    throw new Error(`worktree create template references unavailable placeholder {${missing}}`)
}

function quoteAt(template: string, offset: number): "'" | '"' | null {
  let quote: "'" | '"' | null = null
  for (let i = 0; i < offset; i++) {
    const char = template[i]
    if (char === '\\' && quote !== "'") {
      i++
    } else if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'"
    } else if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"'
    }
  }
  return quote
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Split a seed the way the shell splits words, honouring quotes inside the spec.
 *
 * `--tables='a,b'` and a value containing a space stay one word. Whitespace
 * splits; `;` and other operators remain ordinary characters in the resulting
 * argv because the structured create path never invokes a shell.
 */
function shellWords(spec: string): string[] {
  const words: string[] = []
  let current = ''
  let started = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < spec.length; i++) {
    const char = spec[i]!
    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null
      } else if (char === '\\' && i + 1 < spec.length && '"$`\\\n'.includes(spec[i + 1]!)) {
        current += spec[++i]!
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && i + 1 < spec.length) {
      current += spec[++i]!
      started = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n') {
      if (started) {
        words.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (quote) throw new Error(`unclosed quote in seed: ${spec}`)
  if (started) words.push(current)
  return words
}

export function expandedSeed(seed: string): string[] {
  return shellWords(seed)
}

/**
 * How a seed reaches the project's tool.
 *
 * Expansion is declaration-driven. A normal argument passes the seed once;
 * only the explicit `{ expand: 'seed' }` form enters expandedSeed.
 */
export function seedArgv(create: WorktreeCreate | string | undefined, seed: string): string[] {
  if (typeof create === 'string') {
    const offset = create.indexOf('{seed}')
    if (offset < 0 || quoteAt(create, offset) !== null) return [seed]
    return expandedSeed(seed)
  }
  if (!create || !('command' in create)) return [seed]
  return create.args.some((arg) => typeof arg === 'object' && 'expand' in arg)
    ? expandedSeed(seed)
    : [seed]
}

/** Fill a trusted project command without running it. */
export function fillTool(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, k: string, offset: number) => {
    if (!(k in vars)) return ''
    const value = vars[k]!
    const quote = quoteAt(template, offset)
    if (quote === "'") return value.replace(/'/g, "'\\''")
    if (quote === '"') return value.replace(/[\\"$`]/g, '\\$&')
    // Compatibility for stored string declarations only. New declarations
    // reach expansion through the explicit argument kind instead.
    if (k === 'seed') return seedArgv(template, value).map(shSingleQuote).join(' ')
    return shSingleQuote(value)
  })
}

/** Capabilities declared by structured argv, never inferred from shell text. */
export function createHasPlaceholder(
  create: WorktreeCreate | string | undefined,
  variable: 'branch' | 'name' | 'base' | 'seed' | 'key' | 'path',
): boolean {
  // Legacy rows remain readable during the register migration. Registration
  // still refuses this shape; this substring inference exists only on the
  // compatibility ramp and disappears with its last stored string.
  if (typeof create === 'string') return create.includes(`{${variable}}`)
  if (!create || !('command' in create)) return false
  return (
    create.args.some((arg) => {
      if (typeof arg === 'string') return placeholders(arg).includes(variable)
      if ('expand' in arg) return arg.expand === variable
      return placeholders(arg.value).includes(variable)
    }) || Object.values(create.env ?? {}).some((value) => placeholders(value).includes(variable))
  )
}

export { assertCreateVarsAvailable, CREATE_VARS, fillArg, placeholders, validateCreate }
