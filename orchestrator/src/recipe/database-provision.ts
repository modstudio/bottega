// concern: built-in database lifecycle adapter
/** Reads one declared connection at use time and executes pure database plans without exposing secrets. */
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
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

type ProcessOutput = { exitCode: number | null; stdout: Uint8Array; stderr: string }
export type DatabaseSpawn = (
  argv: string[],
  cwd: string,
  options: { env: Record<string, string>; stdin?: Uint8Array },
) => ProcessOutput

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
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('connection value is not a valid URL')
  }
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

function connectionValue(
  projectRoot: string,
  connection: { key: string; file: string },
): { ok: true; value: string } | { ok: false; detail: string } {
  const file = `${projectRoot}/${connection.file}`
  let values: Record<string, string | undefined>
  try {
    values = parseEnv(readFileSync(file, 'utf8'))
  } catch {
    return {
      ok: false,
      detail: `could not read database connection key ${connection.key} from ${connection.file}; add the key to that main-checkout env file`,
    }
  }
  if (!values[connection.key]) {
    return {
      ok: false,
      detail: `database connection key ${connection.key} is missing from ${connection.file}; add it to that main-checkout env file`,
    }
  }
  return { ok: true, value: values[connection.key]! }
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
): ProcessOutput {
  const call = invocation(command, exec, connection)
  try {
    return spawn(call.argv, cwd, { env: call.environment, stdin: command.input ? dump : undefined })
  } catch {
    return { exitCode: null, stdout: new Uint8Array(), stderr: '' }
  }
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
type Allocation = NonNullable<NonNullable<TrackedRecipe['allocate']>['databases']>[string]

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
  const resolved = connectionValue(context.projectRoot, connectionDeclaration)
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

export function createDatabase(
  key: string,
  allocation: Allocation,
  context: ProvisionContext,
  spawn: DatabaseSpawn = defaultSpawn,
): StepResult {
  const prepared = preparedPlan(key, allocation, context)
  if ('status' in prepared) return prepared
  const { plan, connection } = prepared
  const exec = allocation.provision!.exec
  const cwd = context.commandRoot ?? context.treeRoot
  const exists = inspectExists(plan, exec, connection, cwd, spawn)
  if (exists === null)
    return result(
      key,
      'verify',
      'failed',
      'database existence could not be checked; verify the declared client and admin connection',
    )
  if (exists)
    return plan.reuse
      ? result(key, 'run', 'ok')
      : result(
          key,
          'run',
          'refused',
          `database ${plan.name} already exists; set provision.reuse true to keep it or remove it`,
        )
  let dump: Uint8Array | undefined
  for (const command of plan.create) {
    const executed = runCommand(command, exec, connection, cwd, spawn, dump)
    if (executed.exitCode !== 0) {
      const busy =
        plan.engine === 'postgres' &&
        /being accessed by other users|source database .* is being accessed/i.test(executed.stderr)
      return result(
        key,
        'run',
        'failed',
        busy
          ? `postgres template ${plan.from} has other connections; disconnect them and retry worktree creation`
          : `database create client failed; verify the declared client and admin connection`,
      )
    }
    if (command.output === 'dump') dump = executed.stdout
  }
  return result(key, 'run', 'ok')
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
  const dropped = runCommand(plan.drop, exec, connection, cwd, spawn)
  if (dropped.exitCode !== 0)
    return result(
      key,
      'undo',
      'failed',
      'database drop client failed; verify the declared client and admin connection',
    )
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
): { failure: StepResult | null; compensation: StepResult[] } {
  const declarations = new Map(provisionedDatabases(recipe))
  const entries = creationPlan(recipe).flatMap((phase) => {
    const allocation = phase.kind === 'database' ? declarations.get(phase.name) : undefined
    return allocation ? ([[phase.name, allocation]] as [string, Allocation][]) : []
  })
  for (const [index, [key, allocation]] of entries.entries()) {
    const created = createDatabase(key, allocation, context, spawn)
    if (created.status !== 'ok') {
      return {
        failure: created,
        compensation: entries
          .slice(0, index + 1)
          .reverse()
          .map(([undoKey, undo]) => dropAndVerifyDatabase(undoKey, undo, context, spawn)),
      }
    }
  }
  return { failure: null, compensation: [] }
}

export function dropProvisionedDatabases(
  recipe: TrackedRecipe,
  context: ProvisionContext,
  spawn?: DatabaseSpawn,
): StepResult[] {
  return provisionedDatabases(recipe)
    .reverse()
    .map(([key, allocation]) => dropAndVerifyDatabase(key, allocation, context, spawn))
}
