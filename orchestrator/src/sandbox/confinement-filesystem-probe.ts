// concern: executed confinement probe; owns disposable fixtures and real SRT launches.

import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBounded } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { HARNESS_ENV_FILE_ENV, PLATFORM_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { installationExecutable } from '../../../shared/install-root.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import {
  hubLoginTokenDirectory,
  realPathForPotentialPath,
  resolveHubDatabase,
  resolveStatePaths,
  STATE_HOME_ENV,
  temporaryStateStoreMigrationAllowed,
} from '../../../shared/state-directory.ts'
import { decideStoreAccess } from '../../../shared/store-access.ts'
import { BUILTIN_AGENTS } from '../agent/agents.ts'
import type { Project } from '../project/projects.ts'
import { workerChildEnvironment } from '../run/run-worker-home.ts'
import {
  type RunningInstallLayout,
  resolveRunningInstallLayout,
  runningInstallReadCarveouts,
} from './install-read-policy.ts'
import {
  probeSandboxProfile,
  readonlyLensProfile,
  resetSandbox,
  sandboxLaunchArgv,
  writerProfile,
} from './sandbox.ts'

type FilesystemProbeAccess = 'denied' | 'readable' | 'not covered'
type CommandProbeStatus = 'ran' | 'failed'
type CommandProbe = { status: CommandProbeStatus; reason: string }
export type ConfinementFilesystemProbeRow = {
  family:
    | 'goose'
    | 'grok'
    | 'ACP writer'
    | 'workflow probe'
    | 'cross-project CLI'
    | 'Codex'
    | 'read-only MCP'
    | 'host override'
  status: FilesystemProbeAccess | CommandProbeStatus
  paths: Record<string, FilesystemProbeAccess>
  commands?: Record<string, CommandProbe>
  reason?: string
}

type AccessTarget = { name: string; path: string; expected: 'denied' | 'readable' }

const NOT_COVERED: ConfinementFilesystemProbeRow[] = [
  { family: 'Codex', status: 'not covered', paths: {}, reason: 'Codex has no SRT read profile' },
  {
    family: 'read-only MCP',
    status: 'not covered',
    paths: {},
    reason: 'read-only MCP runs on the host',
  },
  {
    family: 'host override',
    status: 'not covered',
    paths: {},
    reason: 'BOTTEGA_SANDBOX=host bypasses SRT',
  },
]

function fixtureProject(
  recordId: string,
  name: string,
  path: string,
  secretPaths: string[] = [],
): Project {
  return {
    recordId,
    name,
    path,
    stack: 'probe',
    canon: false,
    retiredAt: null,
    settings: { secretPaths },
  }
}

function firstErrorLine(stderr: string): string {
  return stderr.trim().split(/\r?\n/, 1)[0] || 'no stderr'
}

export function probeVerdict(
  targets: readonly AccessTarget[],
  paths: Record<string, FilesystemProbeAccess>,
  command: CommandProbe,
): Pick<ConfinementFilesystemProbeRow, 'status' | 'reason'> {
  if (targets.some(({ name }) => paths[name] === 'not covered')) {
    return {
      status: 'not covered',
      reason: 'one or more filesystem probe output lines were missing',
    }
  }
  if (targets.some(({ name, expected }) => expected === 'denied' && paths[name] === 'readable')) {
    return { status: 'readable' }
  }
  if (targets.some(({ name, expected }) => paths[name] !== expected)) {
    return { status: 'failed', reason: 'one or more expected-readable paths were denied' }
  }
  if (command.status === 'failed') {
    return { status: 'failed', reason: 'the real CLI verb failed' }
  }
  return { status: 'denied' }
}

async function launchCommand(
  profile: ReturnType<typeof readonlyLensProfile>,
  argv: string[],
  environment: Record<string, string>,
  hubOpenMode?: string,
): Promise<CommandProbe> {
  const result = await startBounded(await sandboxLaunchArgv(profile, argv[0]!, argv.slice(1)), {
    budget: 'sandbox-probe',
    env: { ...process.env, ...environment },
  })
  return {
    status: result.exitCode === 0 ? 'ran' : 'failed',
    reason: `exit ${result.exitCode ?? 'unknown'}${result.exitCode === 0 ? '' : `: ${firstErrorLine(result.stderr)}`}${hubOpenMode ? `; hub open mode: ${hubOpenMode}` : ''}`,
  }
}

async function launchProbe(
  family: 'goose' | 'grok' | 'ACP writer' | 'workflow probe',
  profile: ReturnType<typeof readonlyLensProfile>,
  targets: readonly AccessTarget[],
  commandArgv: string[],
  environment: Record<string, string>,
  hubOpenMode: string,
): Promise<ConfinementFilesystemProbeRow> {
  try {
    const script =
      'for path\ndo\nif /bin/cat "$path" >/dev/null 2>&1; then echo readable; else echo denied; fi\ndone'
    const argv = await sandboxLaunchArgv(profile, '/bin/sh', [
      '-c',
      script,
      'probe',
      ...targets.map(({ path }) => path),
    ])
    const result = await startBounded(argv, { budget: 'sandbox-probe' })
    if (result.exitCode !== 0) {
      return {
        family,
        status: 'failed',
        paths: {},
        reason: `filesystem launch exited ${result.exitCode ?? 'unknown'}: ${firstErrorLine(result.stderr)}`,
      }
    }
    const values = result.stdout.trim().split(/\r?\n/)
    const paths = Object.fromEntries(
      targets.map(({ name }, index) => [
        name,
        values[index] === 'denied' || values[index] === 'readable' ? values[index] : 'not covered',
      ]),
    ) as Record<string, FilesystemProbeAccess>
    const command = await launchCommand(profile, commandArgv, environment, hubOpenMode)
    return {
      family,
      ...probeVerdict(targets, paths, command),
      paths,
      commands: { [`${PLATFORM_SLUG} task show DEV-2510`]: command },
    }
  } catch (error) {
    return {
      family,
      status: 'failed',
      paths: {},
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await resetSandbox()
  }
}

async function launchCrossProjectCliProbe(
  profile: ReturnType<typeof readonlyLensProfile>,
  installEnvPath: string,
  cliArgv: string[],
  commandArgv: string[],
  environment: Record<string, string>,
  hubOpenMode: string,
): Promise<ConfinementFilesystemProbeRow> {
  try {
    const targets: AccessTarget[] = [
      { name: 'install .env', path: installEnvPath, expected: 'denied' },
    ]
    const access = await launchCommand(profile, ['/bin/cat', installEnvPath], environment)
    const version = await launchCommand(profile, [...cliArgv, '--version'], environment)
    const verb = await launchCommand(profile, commandArgv, environment, hubOpenMode)
    const paths = { 'install .env': access.status === 'ran' ? 'readable' : 'denied' } as const
    const command: CommandProbe = {
      status: version.status === 'ran' && verb.status === 'ran' ? 'ran' : 'failed',
      reason:
        version.status === 'failed'
          ? `${PLATFORM_SLUG} --version ${version.reason}`
          : `${PLATFORM_SLUG} task show DEV-2510 ${verb.reason}`,
    }
    const verdict = probeVerdict(targets, paths, command)
    return {
      family: 'cross-project CLI',
      status: verdict.status === 'denied' ? 'ran' : 'failed',
      paths,
      commands: {
        [`${PLATFORM_SLUG} --version`]: version,
        [`${PLATFORM_SLUG} task show DEV-2510`]: verb,
      },
      reason:
        verdict.status === 'denied'
          ? undefined
          : verdict.status === 'readable'
            ? 'the install .env was unexpectedly readable'
            : verdict.reason,
    }
  } catch (error) {
    return {
      family: 'cross-project CLI',
      status: 'failed',
      paths: { 'install .env': 'not covered' },
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await resetSandbox()
  }
}

function openLiveHubFixture(destination: string): Database {
  const source = new Database(resolveHubDatabase(process.env), { readonly: true })
  try {
    writeFileSync(destination, source.serialize())
  } finally {
    source.close()
  }
  const writer = new Database(destination, { readwrite: true, create: false })
  writer.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE IF NOT EXISTS confinement_probe_live_wal (marker TEXT NOT NULL);
    INSERT INTO confinement_probe_live_wal (marker) VALUES ('held-open');
  `)
  if (!existsSync(`${destination}-wal`) || !existsSync(`${destination}-shm`)) {
    writer.close()
    throw new Error(`live hub fixture did not create WAL sidecars for ${destination}`)
  }
  return writer
}

function installFixture(root: string, running: RunningInstallLayout): RunningInstallLayout {
  mkdirSync(root, { recursive: true })
  for (const name of ['cli', 'shared', 'hub', 'orchestrator', 'node_modules']) {
    symlinkSync(join(running.root, name), join(root, name), 'dir')
  }
  const fixtureBin = join(root, 'bin')
  mkdirSync(fixtureBin)
  copyFileSync(installationExecutable(running.root, running.kind), join(fixtureBin, PLATFORM_SLUG))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'probe-install' }))
  writeFileSync(join(root, '.env'), 'PLANTED_INSTALL_SECRET=fixture\n')
  return {
    kind: 'checkout',
    root,
    workspaceDirectories: [join(root, 'hub'), join(root, 'orchestrator')],
  }
}

function probeWorkerEnvironment(environment: Record<string, string>): Record<string, string> {
  return workerChildEnvironment({
    agent: BUILTIN_AGENTS.grok!,
    sandbox: 'srt',
    runRecordId: 'confinement-filesystem-probe',
    runToken: 'confinement-filesystem-probe-token',
    runNumber: 1,
    environment,
    stateEnvironment: environment,
    includeStore: true,
  })
}

function probeHubOpenMode(hubDatabase: string): string {
  return decideStoreAccess({
    restrictedActor: true,
    storePathUnderTemporaryRoot: temporaryStateStoreMigrationAllowed(
      realPathForPotentialPath(hubDatabase),
      realPathForPotentialPath(tmpdir()),
    ),
    walOrShmSidecarPresent: existsSync(`${hubDatabase}-wal`) || existsSync(`${hubDatabase}-shm`),
  }).openMode
}

function createProbeFixture(root: string) {
  const ownPath = join(root, 'projects', 'own')
  const worktree = join(ownPath, '.claude', 'worktrees', 'own')
  const siblingWorktree = join(ownPath, '.claude', 'worktrees', 'sibling')
  const siblingPath = join(root, 'projects', 'sibling')
  const stateRoot = join(root, 'state')
  const runningInstall = resolveRunningInstallLayout(process.env)
  const fixtureInstall = installFixture(join(root, 'projects', 'install'), runningInstall)
  const hubDatabase = join(stateRoot, 'hub', 'hub.db')
  const environment = {
    ...process.env,
    HOME: join(root, 'home'),
    [STATE_HOME_ENV]: stateRoot,
    BOTTEGA_HUB_DB: hubDatabase,
    [HARNESS_ENV_FILE_ENV]: '',
    [PLATFORM_ENV_FILE_ENV]: '',
  } as Record<string, string>
  const state = resolveStatePaths(environment)
  const runtimeDir = join(state.orchestratorRuns, 'sandbox-probe')
  const scratchDir = join(state.orchestratorRuns, 'probe', 'scratch')
  const own = fixtureProject('own', 'own', ownPath, ['declared.secret'])
  const sibling = fixtureProject('sibling', 'sibling', siblingPath)
  const registeredProjects = [
    own,
    sibling,
    fixtureProject('fixture-install', 'fixture-install', fixtureInstall.root),
    fixtureProject('running-install', PLATFORM_SLUG, runningInstall.root),
  ]
  const targets: AccessTarget[] = [
    { name: 'sibling .env', path: join(siblingPath, '.env'), expected: 'denied' },
    { name: 'sibling .mcp.json', path: join(siblingPath, '.mcp.json'), expected: 'denied' },
    { name: 'orchestrator store', path: state.orchestratorDatabase, expected: 'denied' },
    { name: 'own secret', path: join(ownPath, 'declared.secret'), expected: 'denied' },
    {
      name: 'same-project sibling worktree',
      path: join(siblingWorktree, '.env'),
      expected: 'denied',
    },
    {
      name: 'another run directory',
      path: join(state.orchestratorRuns, 'another-run', 'planted.txt'),
      expected: 'denied',
    },
    { name: 'own tree', path: join(worktree, 'visible.txt'), expected: 'readable' },
    {
      name: 'own .git objects',
      path: join(ownPath, '.git', 'objects', 'visible'),
      expected: 'readable',
    },
  ]
  for (const { path } of targets) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'fixture')
  }
  targets.push({
    name: 'running package.json',
    path: join(runningInstall.root, 'package.json'),
    expected: 'readable',
  })
  mkdirSync(runtimeDir, { recursive: true })
  mkdirSync(scratchDir, { recursive: true })
  mkdirSync(state.hubDirectory, { recursive: true })
  const hubWriter = openLiveHubFixture(hubDatabase)
  const loginToken = join(hubLoginTokenDirectory(environment), 'planted-token')
  mkdirSync(join(loginToken, '..'), { recursive: true })
  writeFileSync(loginToken, 'PLANTED_HUB_TOKEN=fixture\n')
  targets.push(
    { name: 'hub store', path: hubDatabase, expected: 'readable' },
    { name: 'hub login token', path: loginToken, expected: 'denied' },
  )
  const cliArgv = bottegaEntryArgv(PLATFORM_SLUG)
  return {
    hubWriter,
    hubOpenMode: probeHubOpenMode(hubDatabase),
    stateRoot,
    targets,
    cliArgv,
    commandArgv: [...cliArgv, 'task', 'show', 'DEV-2510'],
    fixtureInstall,
    environment: probeWorkerEnvironment(environment),
    common: {
      worktree,
      runtimeDir,
      scratchDir,
      project: own,
      registeredProjects,
      path: '/bin:/usr/bin',
      nodeModuleLinks: runningInstallReadCarveouts(runningInstall),
      installLayout: fixtureInstall,
      environment,
      socketDenyPaths: [],
    },
  }
}

/** Execute each SRT profile family against planted sibling, state, secret, and own-tree paths. */
export async function runConfinementFilesystemProbes(): Promise<ConfinementFilesystemProbeRow[]> {
  const probeParent = process.env.BOTTEGA_SCRATCH ?? resolveStatePaths(process.env).orchestratorRuns
  mkdirSync(probeParent, { recursive: true })
  const root = mkdtempSync(join(probeParent, `${PLATFORM_SLUG}-confinement-probe-`))
  const priorStateRoot = process.env[STATE_HOME_ENV]
  let hubWriter: Database | null = null
  try {
    const fixture = createProbeFixture(root)
    hubWriter = fixture.hubWriter
    const {
      stateRoot,
      targets,
      cliArgv,
      commandArgv,
      fixtureInstall,
      environment,
      common,
      hubOpenMode,
    } = fixture
    process.env[STATE_HOME_ENV] = stateRoot
    return [
      await launchProbe(
        'goose',
        readonlyLensProfile({ ...common, agent: 'goose' }),
        targets,
        commandArgv,
        environment,
        hubOpenMode,
      ),
      await launchProbe(
        'grok',
        readonlyLensProfile({ ...common, agent: 'grok' }),
        targets,
        commandArgv,
        environment,
        hubOpenMode,
      ),
      await launchProbe(
        'ACP writer',
        writerProfile({ ...common, agent: 'grok', askAddress: '127.0.0.1:1' }),
        targets,
        commandArgv,
        environment,
        hubOpenMode,
      ),
      await launchProbe(
        'workflow probe',
        probeSandboxProfile({
          allowWriteDir: common.runtimeDir,
          cwd: common.worktree,
          project: common.project,
          registeredProjects: common.registeredProjects,
          environment: common.environment,
          socketDenyPaths: common.socketDenyPaths,
          installLayout: common.installLayout,
        }),
        targets,
        commandArgv,
        environment,
        hubOpenMode,
      ),
      await launchCrossProjectCliProbe(
        readonlyLensProfile({ ...common, agent: 'grok' }),
        join(fixtureInstall.root, '.env'),
        cliArgv,
        commandArgv,
        environment,
        hubOpenMode,
      ),
      ...NOT_COVERED,
    ]
  } finally {
    hubWriter?.close()
    if (priorStateRoot === undefined) delete process.env[STATE_HOME_ENV]
    else process.env[STATE_HOME_ENV] = priorStateRoot
    rmSync(root, { recursive: true, force: true })
  }
}

export function formatConfinementFilesystemProbes(
  rows: readonly ConfinementFilesystemProbeRow[],
): string[] {
  return rows.map((row) => {
    if (row.status === 'not covered')
      return `filesystem-probe  ${row.family}  not covered: ${row.reason}`
    const paths = Object.entries(row.paths)
      .map(([name, access]) => `${name}=${access}`)
      .join(' ')
    const commands = Object.entries(row.commands ?? {})
      .map(([name, result]) => `${name}=${result.status}(${result.reason})`)
      .join(' ')
    const reason = row.reason ? ` reason=${row.reason}` : ''
    return `filesystem-probe  ${row.family}  ${row.status}  ${paths}${commands ? ` ${commands}` : ''}${reason}`
  })
}
