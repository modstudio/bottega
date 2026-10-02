// concern: built-in database lifecycle adapter
/** Reads one declared connection at use time and executes pure database plans without exposing secrets. */
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseConnectionUrl, readConnectionValue } from './database-connection.ts'
import {
  type DatabaseCommand,
  type DatabaseCommandPlan,
  databaseCommandPlan,
  outputHasExactDatabase,
  provisionedDatabases,
} from './database-provision-plan.ts'
import { creationPlan } from './recipe-lifecycle.ts'
import type { TrackedRecipe } from './recipe-schema.ts'
import { type ExecContext, executionArgv, type StepResult } from './recipe-step.ts'

export type DatabaseProcessOutput = {
  exitCode: number | null
  stdout: Uint8Array
  stderr: string
}
export type DatabaseSpawn = (
  argv: string[],
  cwd: string,
  options: { env: Record<string, string>; stdin?: Uint8Array },
) => DatabaseProcessOutput

const defaultSpawn: DatabaseSpawn = (argv, cwd, options) => {
  const result = Bun.spawnSync(argv, {
    cwd,
    env: { ...process.env, ...options.env },
    stdin: options.stdin,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr.toString(),
  }
}

type Connection = {
  environment: Record<string, string>
  arguments: string[]
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function clientConnection(engine: DatabaseCommandPlan['engine'], value: string): Connection {
  const url = parseConnectionUrl(value)
  if (engine === 'postgres') {
    if (!['postgres:', 'postgresql:'].includes(url.protocol))
      throw new Error('connection URL must use postgres or postgresql')
    return {
      environment: {
        PGHOST: url.hostname,
        PGPORT: url.port || '5432',
        PGUSER: decode(url.username),
        PGPASSWORD: decode(url.password),
        ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode')! } : {}),
      },
      arguments: [],
    }
  }
  if (!['mysql:', 'mariadb:'].includes(url.protocol))
    throw new Error('connection URL must use mysql or mariadb')
  return {
    environment: { MYSQL_PWD: decode(url.password) },
    arguments: [
      `--host=${url.hostname}`,
      `--port=${url.port || '3306'}`,
      `--user=${decode(url.username)}`,
    ],
  }
}

function result(
  name: string,
  phase: StepResult['phase'],
  status: StepResult['status'],
  detail = '',
): StepResult {
  return {
    name: `database ${name}`,
    phase,
    status,
    exitCode: status === 'ok' ? 0 : null,
    argv: null,
    detail,
    durationMs: 0,
  }
}

function invocation(
  command: DatabaseCommand,
  exec: ExecContext,
  connection: Connection | null,
): { argv: string[]; environment: Record<string, string> } {
  const environment = connection?.environment ?? {}
  const argv = connection
    ? [command.argv[0]!, ...connection.arguments, ...command.argv.slice(1)]
    : command.argv
  return {
    argv: executionArgv(argv, exec, Object.keys(environment)),
    environment,
  }
}

function runCommand(
  command: DatabaseCommand,
  exec: ExecContext,
  connection: Connection | null,
  cwd: string,
  spawn: DatabaseSpawn,
  dump?: Uint8Array,
): DatabaseProcessOutput {
  const call = invocation(command, exec, connection)
  try {
    return spawn(call.argv, cwd, { env: call.environment, stdin: command.input ? dump : undefined })
  } catch {
    return { exitCode: null, stdout: new Uint8Array(), stderr: '' }
  }
}

/** Run an administrative database command through the lifecycle's connection and exec adapter. */
export function runDatabaseClient(
  input: {
    command: DatabaseCommand
    engine: Exclude<DatabaseCommandPlan['engine'], 'sqlite'>
    connectionValue: string
    exec: ExecContext
    cwd: string
  },
  spawn: DatabaseSpawn = defaultSpawn,
): DatabaseProcessOutput {
  return runCommand(
    input.command,
    input.exec,
    clientConnection(input.engine, input.connectionValue),
    input.cwd,
    spawn,
  )
}

function inspectExists(
  plan: DatabaseCommandPlan,
  exec: ExecContext,
  connection: Connection | null,
  cwd: string,
  spawn: DatabaseSpawn,
): boolean | null {
  const inspected = runCommand(plan.inspect!, exec, connection, cwd, spawn)
  if (plan.engine === 'sqlite') {
    if (inspected.exitCode === 0) return true
    return inspected.exitCode === 1 ? false : null
  }
  return inspected.exitCode === 0
    ? outputHasExactDatabase(new TextDecoder().decode(inspected.stdout), plan.name)
    : null
}

type ProvisionContext = {
  projectRoot: string
  treeRoot: string
  commandRoot?: string
  allocations: Record<string, string>
}
export type DatabaseOwnership = Record<string, boolean>
type Allocation = NonNullable<NonNullable<TrackedRecipe['allocate']>['databases']>[string]

function isBeneath(root: string, path: string): boolean {
  const offset = relative(root, path)
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
}

function confinedPath(root: string, path: string): string | null {
  let canonicalRoot: string
  try {
    canonicalRoot = realpathSync(root)
  } catch {
    return `${root} could not be resolved; restore the declared root and retry`
  }
  const confined = resolve(canonicalRoot, relative(root, path))
  if (!isBeneath(canonicalRoot, confined))
    return `${path} is outside ${canonicalRoot}; choose a path inside the declared root`
  let current = canonicalRoot
  const components = relative(canonicalRoot, confined).split(sep).filter(Boolean)
  for (const [index, component] of components.entries()) {
    current = resolve(current, component)
    let state: ReturnType<typeof lstatSync>
    try {
      state = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return `${current} could not be inspected; repair that path and retry`
    }
    if (state.isSymbolicLink()) return `${current} is a symbolic link; replace it and retry`
    if (index < components.length - 1 && !state.isDirectory())
      return `${current} is not a directory; replace it and retry`
  }
  return null
}

function sqlitePathProblem(plan: DatabaseCommandPlan, context: ProvisionContext): string | null {
  if (plan.engine !== 'sqlite') return null
  const source = plan.create[0]!.argv.at(-2)!
  const target = plan.create[0]!.argv.at(-1)!
  return confinedPath(context.projectRoot, source) ?? confinedPath(context.treeRoot, target)
}

function rootIsMissing(root: string): boolean {
  try {
    lstatSync(root)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function preparedPlan(
  key: string,
  allocation: Allocation,
  context: ProvisionContext,
): { plan: DatabaseCommandPlan; connection: Connection | null } | StepResult {
  const provision = allocation.provision!
  let plan: DatabaseCommandPlan
  try {
    plan = databaseCommandPlan({
      engine: allocation.engine as DatabaseCommandPlan['engine'],
      name: context.allocations[key]!,
      from: provision.from,
      reuse: provision.reuse ?? false,
      projectRoot: context.projectRoot,
      treeRoot: context.treeRoot,
    })
  } catch (error) {
    return result(key, 'run', 'refused', String((error as Error)?.message ?? error))
  }
  if (plan.engine === 'sqlite') return { plan, connection: null }
  const connectionDeclaration = {
    key: provision.connection.key,
    file: provision.connection.file ?? '.env',
  }
  const resolved = readConnectionValue(context.projectRoot, connectionDeclaration)
  if (!resolved.ok) return result(key, 'run', 'refused', resolved.detail)
  try {
    return { plan, connection: clientConnection(plan.engine, resolved.value) }
  } catch (error) {
    return result(
      key,
      'run',
      'refused',
      `database connection key ${connectionDeclaration.key} in ${connectionDeclaration.file} is unusable: ${String((error as Error)?.message ?? error)}`,
    )
  }
}

type CreateOutcome = { step: StepResult; owned: boolean }

function inspectedCreateOutcome(
  key: string,
  plan: DatabaseCommandPlan,
  exists: boolean | null,
): CreateOutcome | null {
  if (exists === null)
    return {
      step: result(
        key,
        'verify',
        'failed',
        'database existence could not be checked; verify the declared client and admin connection',
      ),
      owned: false,
    }
  if (!exists) return null
  return {
    step: plan.reuse
      ? result(key, 'run', 'ok')
      : result(
          key,
          'run',
          'refused',
          `database ${plan.name} already exists; set provision.reuse true to keep it or remove it`,
        ),
    owned: false,
  }
}

function runCreatePlan(input: {
  key: string
  plan: DatabaseCommandPlan
  context: ProvisionContext
  exec: ExecContext
  connection: Connection | null
  cwd: string
  spawn: DatabaseSpawn
}): CreateOutcome {
  let dump: Uint8Array | undefined
  let owned = false
  for (const [index, command] of input.plan.create.entries()) {
    const mutationProblem = sqlitePathProblem(input.plan, input.context)
    if (mutationProblem)
      return { step: result(input.key, 'run', 'refused', mutationProblem), owned }
    const executed = runCommand(command, input.exec, input.connection, input.cwd, input.spawn, dump)
    if (executed.exitCode !== 0) {
      const busy =
        input.plan.engine === 'postgres' &&
        /being accessed by other users|source database .* is being accessed/i.test(executed.stderr)
      return {
        step: result(
          input.key,
          'run',
          'failed',
          busy
            ? `postgres template ${input.plan.from} has other connections; disconnect them and retry worktree creation`
            : `database create client failed; verify the declared client and admin connection`,
        ),
        owned,
      }
    }
    if (index === 0) owned = true
    if (command.output === 'dump') dump = executed.stdout
  }
  return { step: result(input.key, 'run', 'ok'), owned }
}

export function createDatabase(
  key: string,
  allocation: Allocation,
  context: ProvisionContext,
  spawn: DatabaseSpawn = defaultSpawn,
): CreateOutcome {
  const prepared = preparedPlan(key, allocation, context)
  if ('status' in prepared) return { step: prepared, owned: false }
  const { plan, connection } = prepared
  const exec = allocation.provision!.exec
  const cwd = context.commandRoot ?? context.treeRoot
  const inspectProblem = sqlitePathProblem(plan, context)
  if (inspectProblem)
    return { step: result(key, 'verify', 'refused', inspectProblem), owned: false }
  const inspected = inspectedCreateOutcome(
    key,
    plan,
    inspectExists(plan, exec, connection, cwd, spawn),
  )
  return inspected ?? runCreatePlan({ key, plan, context, exec, connection, cwd, spawn })
}

export function dropAndVerifyDatabase(
  key: string,
  allocation: Allocation,
  context: ProvisionContext,
  spawn: DatabaseSpawn = defaultSpawn,
): StepResult {
  const prepared = preparedPlan(key, allocation, context)
  if ('status' in prepared) return { ...prepared, phase: 'undo' }
  const { plan, connection } = prepared
  const exec = allocation.provision!.exec
  const cwd = context.commandRoot ?? context.treeRoot
  if (plan.engine === 'sqlite' && rootIsMissing(context.treeRoot))
    return result(
      key,
      'verify',
      'ok',
      `tree ${context.treeRoot} is gone, so its SQLite database is gone`,
    )
  const dropProblem = sqlitePathProblem(plan, context)
  if (dropProblem) return result(key, 'undo', 'refused', dropProblem)
  const dropped = runCommand(plan.drop, exec, connection, cwd, spawn)
  if (dropped.exitCode !== 0)
    return result(
      key,
      'undo',
      'failed',
      'database drop client failed; verify the declared client and admin connection',
    )
  const verifyProblem = sqlitePathProblem(plan, context)
  if (verifyProblem) return result(key, 'verify', 'refused', verifyProblem)
  const exists = inspectExists(plan, exec, connection, cwd, spawn)
  if (exists === null)
    return result(
      key,
      'verify',
      'failed',
      'database removal could not be verified; verify the declared client and admin connection',
    )
  return exists
    ? result(
        key,
        'verify',
        'failed',
        `database ${plan.name} still exists after drop; remove it and retry teardown`,
      )
    : result(key, 'verify', 'ok')
}

export function createProvisionedDatabases(
  recipe: TrackedRecipe,
  context: ProvisionContext,
  spawn?: DatabaseSpawn,
): {
  failure: StepResult | null
  compensation: StepResult[]
  ownership: DatabaseOwnership
} {
  const declarations = new Map(provisionedDatabases(recipe))
  const entries = creationPlan(recipe).flatMap((phase) => {
    const allocation = phase.kind === 'database' ? declarations.get(phase.name) : undefined
    return allocation ? ([[phase.name, allocation]] as [string, Allocation][]) : []
  })
  const ownedEntries: [string, Allocation][] = []
  const ownership: DatabaseOwnership = {}
  for (const [key, allocation] of entries) {
    const outcome = createDatabase(key, allocation, context, spawn)
    ownership[key] = outcome.owned
    if (outcome.owned) ownedEntries.push([key, allocation])
    if (outcome.step.status !== 'ok') {
      return {
        failure: outcome.step,
        compensation: ownedEntries
          .reverse()
          .map(([undoKey, undo]) => dropAndVerifyDatabase(undoKey, undo, context, spawn)),
        ownership,
      }
    }
  }
  return { failure: null, compensation: [], ownership }
}

export function dropProvisionedDatabases(
  recipe: TrackedRecipe,
  context: ProvisionContext,
  ownership?: DatabaseOwnership,
  spawn?: DatabaseSpawn,
): StepResult[] {
  return provisionedDatabases(recipe)
    .reverse()
    .map(([key, allocation]) => {
      if (ownership?.[key]) return dropAndVerifyDatabase(key, allocation, context, spawn)
      const name = context.allocations[key] ?? key
      return result(
        key,
        'undo',
        'ok',
        Object.hasOwn(ownership ?? {}, key)
          ? `database ${name} was not created by this lifecycle and was kept`
          : `database ${name} has no recorded ownership and was kept`,
      )
    })
}
