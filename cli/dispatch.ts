import { basename } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { BOTTEGA_ENTRY_PROTOCOL } from '../shared/self-spawn.ts'
import { INTERNAL_CALL_ENV, recordLegacyCall, reportLegacyCalls } from './legacy-calls.ts'
import { GROUPS, ROUTES, resolveRoute } from './routes.ts'

export type BinaryEntries = {
  orch(argv: string[], invocation?: OwnerInvocation): Promise<number>
  hub(argv: string[], invocation?: OwnerInvocation): Promise<number>
  orchOutbox(): Promise<Record<string, unknown>[]>
  hubOutbox(): Promise<Record<string, unknown>[]>
  hubOutboxSummaryLines(rows: readonly Record<string, unknown>[]): Promise<string[]>
  runExec(argv: string[]): Promise<number>
  askProxy(argv: string[]): Promise<number>
  retrievalSearch(argv: string[]): Promise<void>
  checkAttribution(argv: string[]): Promise<number>
  schemaCheck(argv: string[]): Promise<number>
}

type OwnerInvocation = {
  publicPath: readonly string[]
  ownerPath: readonly string[]
}

type OutboxOwner = 'orch' | 'hub'

function qualifiedOutboxRows(
  owner: OutboxOwner,
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.map((row) => ({ ...row, id: `${owner}:${String(row.id)}`, owner }))
}

async function dispatchOutbox(
  rest: string[],
  entries: BinaryEntries,
  invocation: OwnerInvocation,
): Promise<number> {
  if (rest[0] === 'trace') return entries.hub(['outbox', ...rest], invocation)
  if (rest.length === 0 || (rest.length === 1 && rest[0] === '--json')) {
    const hubRows = await entries.hubOutbox()
    const rows = [
      ...qualifiedOutboxRows('orch', await entries.orchOutbox()),
      ...qualifiedOutboxRows('hub', hubRows),
    ]
    if (rest[0] === '--json') console.log(JSON.stringify(rows))
    else if (!rows.length) console.log('record outbox is empty')
    else {
      for (const line of await entries.hubOutboxSummaryLines(hubRows)) console.log(line)
      for (const { id, owner, ...row } of rows)
        console.log(`${String(id)} ${JSON.stringify({ owner, ...row })}`)
    }
    return 0
  }
  const [verb, qualifiedId, ...extraArguments] = rest
  const match = qualifiedId?.match(/^(orch|hub):(.+)$/)
  if (!match) {
    console.error(
      `outbox entry ids must include their owner; run \`${PLATFORM_SLUG} record outbox\` to list them`,
    )
    return 2
  }
  const owner = match[1] as OutboxOwner
  const id = match[2]!
  // The orchestrator reads its id with Number(), which turns `1e2` or `0x10` into another row.
  if (owner === 'orch' && !/^\d+$/.test(id)) {
    console.error(
      `orchestrator outbox ids are decimal row numbers; run \`${PLATFORM_SLUG} record outbox\``,
    )
    return 2
  }
  // Each owner's own command validates the verb, so its verb list has one definition.
  const prefix = owner === 'orch' ? ['record', 'outbox'] : ['outbox']
  return entries[owner](
    [...prefix, verb!, id, ...extraArguments],
    invocationFor(prefix, invocation.publicPath),
  )
}

function invocationFor(
  ownerPath: readonly string[],
  publicPath: readonly string[],
): OwnerInvocation {
  return { ownerPath, publicPath }
}

function legacyInvocation(
  owner: 'orch' | 'hub',
  argv: readonly string[],
): OwnerInvocation | undefined {
  const matches: { ownerPath: readonly string[]; publicPath: readonly string[] }[] = []
  for (const route of ROUTES) {
    const targets =
      route.composite ?? (route.owner === owner ? [{ owner, argv: route.argv ?? [] }] : [])
    for (const target of targets) {
      if (target.owner !== owner || target.argv.length === 0) continue
      if (target.argv.every((part, index) => argv[index] === part)) {
        matches.push({ ownerPath: target.argv, publicPath: route.command })
      }
    }
  }
  const best = matches.sort((left, right) => right.ownerPath.length - left.ownerPath.length)[0]
  return best ? invocationFor(best.ownerPath, best.publicPath) : undefined
}

function topHelp(): void {
  console.log(`usage: ${PLATFORM_SLUG} <group> [command] [arguments]\n`)
  console.log('Groups:')
  for (const [name, description] of GROUPS) console.log(`  ${name.padEnd(12)} ${description}`)
}

async function groupHelp(group: string, entries: BinaryEntries): Promise<number> {
  const commands = new Map<string, string>()
  for (const route of ROUTES) {
    if (route.hidden || route.command[0] !== group || route.command.length < 2) continue
    commands.set(route.command[1]!, route.description ?? '')
  }
  console.log(`usage: ${PLATFORM_SLUG} ${group} <command> [arguments]\n`)
  console.log('Commands:')
  for (const [name, description] of [...commands].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${name.padEnd(28)} ${description}`.trimEnd())
  }
  const passThrough = ROUTES.find(
    (route) => route.command.length === 1 && route.command[0] === group,
  )
  if (passThrough?.owner === 'orch' || passThrough?.owner === 'hub') {
    console.log('\nOwner commands:')
    const ownerPath = passThrough.argv ?? []
    return entries[passThrough.owner](
      [...ownerPath, '--help'],
      invocationFor(ownerPath, passThrough.command),
    )
  }
  return 0
}

async function legacy(
  oldName: 'orch' | 'hub',
  argv: string[],
  entries: BinaryEntries,
): Promise<number> {
  const internal = process.env[INTERNAL_CALL_ENV] === '1'
  recordLegacyCall(oldName, argv, internal ? 'internal' : 'external')
  process.env[INTERNAL_CALL_ENV] = '1'
  return entries[oldName](argv, legacyInvocation(oldName, argv))
}

async function composite(
  route: NonNullable<ReturnType<typeof resolveRoute>>['route'],
  rest: string[],
  entries: BinaryEntries,
): Promise<number> {
  const parts = route.composite ?? []
  const partArguments = parts.map(() => [] as string[])
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!
    const option = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument
    const ownerIndex = parts.findIndex((part) => part.options?.[option] !== undefined)
    if (ownerIndex < 0) {
      console.error(`unknown composite option: ${argument}`)
      return 2
    }
    partArguments[ownerIndex]!.push(argument)
    if (parts[ownerIndex]!.options?.[option] && !argument.includes('=')) {
      const value = rest[++index]
      if (value === undefined) {
        console.error(`option requires an argument: ${option}`)
        return 2
      }
      partArguments[ownerIndex]!.push(value)
    }
  }
  let result = 0
  for (const [index, part] of parts.entries()) {
    console.error(`== ${part.label} ==`)
    const code = await entries[part.owner](
      [...part.argv, ...partArguments[index]!],
      invocationFor(part.argv, route.command),
    )
    if (code !== 0 && result === 0) result = code
    if (code !== 0 && !route.continueOnFailure) break
  }
  return result
}

/** Route public and hidden executable commands without publishing hidden commands in usage. */
export async function dispatchBinary(
  argv: string[],
  invokedAs: string,
  entries: BinaryEntries,
  version: () => string,
): Promise<number> {
  const executable = basename(invokedAs)
  if (executable === 'orch' || executable === 'hub') return legacy(executable, argv, entries)
  const input = argv
  if (input[0] === 'orch' || input[0] === 'hub') {
    return legacy(input[0], input.slice(1), entries)
  }
  process.env[INTERNAL_CALL_ENV] = '1'
  if (input.length === 1 && input[0] === '--version') {
    console.log(version())
    return 0
  }
  if (input.length === 0 || (input.length === 1 && input[0] === '--help')) {
    topHelp()
    return 0
  }
  const [command, ...rest] = input
  if (command === BOTTEGA_ENTRY_PROTOCOL['run-exec'].compiledArguments[0])
    return entries.runExec(rest)
  if (command === BOTTEGA_ENTRY_PROTOCOL['ask-proxy'].compiledArguments[0])
    return entries.askProxy(rest)
  if (command === BOTTEGA_ENTRY_PROTOCOL['retrieval-search'].compiledArguments[0]) {
    await entries.retrievalSearch(rest)
    return Number(process.exitCode ?? 0)
  }
  if (command === BOTTEGA_ENTRY_PROTOCOL['check-attribution'].compiledArguments[0])
    return entries.checkAttribution(rest)
  if (command === BOTTEGA_ENTRY_PROTOCOL['schema-check'].compiledArguments[0])
    return entries.schemaCheck(rest)
  const group = GROUPS.find(([name]) => name === command)
  if (group && input.length === 2 && input[1] === '--help') {
    return groupHelp(command!, entries)
  }
  const resolved = resolveRoute(input)
  if (!resolved) {
    console.error(`unknown command: ${input.join(' ')}\nrun ${PLATFORM_SLUG} --help for usage`)
    return 2
  }
  if (resolved.route.owner === 'local') return reportLegacyCalls(resolved.rest)
  if (resolved.route.owner === 'outbox') {
    const ownerPath = resolved.route.argv ?? []
    return dispatchOutbox(
      [...ownerPath, ...resolved.rest],
      entries,
      invocationFor(['outbox', ...ownerPath], resolved.route.command),
    )
  }
  if (resolved.route.owner === 'composite') return composite(resolved.route, resolved.rest, entries)
  const ownerArgv = [...(resolved.route.argv ?? []), ...resolved.rest]
  return entries[resolved.route.owner](
    ownerArgv,
    invocationFor(resolved.route.argv ?? [], resolved.route.command),
  )
}
