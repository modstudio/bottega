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
import { dirname, join } from 'node:path'
import { startBounded, startBoundedSync } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { HARNESS_ENV_FILE_ENV, PLATFORM_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { installationExecutable } from '../../../shared/install-root.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import {
  hubLoginTokenDirectory,
  realPathForPotentialPath,
  resolveHubDatabase,
  resolveOrchestratorDatabase,
  resolveStatePaths,
  STATE_HOME_ENV,
  temporaryStateStoreMigrationAllowed,
} from '../../../shared/state-directory.ts'
import { decideStoreAccess } from '../../../shared/store-access.ts'
import { BUILTIN_AGENTS } from '../agent/agents.ts'
import { assertBranchRefMayBeCreated } from '../branch/branch-ref-guard.ts'
import { targetGitEnvironment, worktreeGitDir } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { prepareSharedRefGuard, workerSharedGitRoots } from '../resources/ref-guard.ts'
import { workerChildEnvironment } from '../run/run-worker-home.ts'
import { codexPermissionProfileArgs, codexPermissionProfileInput } from './codex-sandbox.ts'
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
    | 'extracted ref guard executes under the area deny'
    | 'Codex'
    | 'read-only MCP'
    | 'host override'
  status: FilesystemProbeAccess | CommandProbeStatus | 'committed' | 'refused'
  paths: Record<string, FilesystemProbeAccess>
  commands?: Record<string, CommandProbe>
  reason?: string
}

type AccessTarget = {
  name: string
  path: string
  expected: 'denied' | 'readable'
  plant?: boolean
  createAfterLaunch?: boolean
}

type AfterLaunchFixture = { target: string; ready: string; release: string }

const NOT_COVERED: ConfinementFilesystemProbeRow[] = [
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

async function launchCodexProbe(
  profile: ReturnType<typeof readonlyLensProfile>,
  targets: readonly AccessTarget[],
  cwd: string,
  environment: Record<string, string>,
): Promise<ConfinementFilesystemProbeRow> {
  const codex = Bun.which('codex')
  if (!codex) {
    return {
      family: 'Codex',
      status: 'not covered',
      paths: {},
      reason: 'codex is not installed',
    }
  }
  try {
    const permissionArgs = codexPermissionProfileArgs({
      ...codexPermissionProfileInput({
        profile,
        sandbox: 'workspace-write',
        cwd,
        writableRoots: profile.filesystem.allowWrite,
        tempDir: environment.TMPDIR,
        repository: true,
      }),
      network: false,
    })
    const result = await startBounded(
      [
        codex,
        'sandbox',
        '-P',
        PLATFORM_SLUG,
        ...permissionArgs,
        '--',
        '/bin/sh',
        '-c',
        'for path\ndo\nif /bin/cat "$path" >/dev/null 2>&1; then echo readable; else echo denied; fi\ndone',
        'probe',
        ...targets.map(({ path }) => path),
      ],
      { budget: 'sandbox-probe', cwd, env: { ...process.env, ...environment } },
    )
    if (result.exitCode !== 0) {
      return {
        family: 'Codex',
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
    return {
      family: 'Codex',
      ...probeVerdict(targets, paths, { status: 'ran', reason: 'codex sandbox ran' }),
      paths,
    }
  } catch (error) {
    return {
      family: 'Codex',
      status: 'failed',
      paths: {},
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

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

function stderrTail(stderr: string): string {
  return stderr.trim().split(/\r?\n/).slice(-3).join(' | ') || 'no stderr'
}

function gitFixture(argv: string[], cwd: string): string {
  const result = startBoundedSync(['git', ...argv], {
    budget: 'git-plumbing',
    cwd,
    env: targetGitEnvironment(cwd),
  })
  if (result.exitCode !== 0) {
    throw new Error(`git fixture command failed with exit ${result.exitCode}: ${argv.join(' ')}`)
  }
  return result.stdout.trim()
}

function initializeProbeGitFixture(ownPath: string, worktree: string): void {
  mkdirSync(ownPath, { recursive: true })
  gitFixture(['init', '--initial-branch=main'], ownPath)
  gitFixture(['config', 'user.email', 'confinement-probe@example.invalid'], ownPath)
  gitFixture(['config', 'user.name', 'Confinement Probe'], ownPath)
  writeFileSync(join(ownPath, 'fixture.txt'), 'fixture')
  gitFixture(['add', 'fixture.txt'], ownPath)
  gitFixture(['commit', '-m', 'probe fixture'], ownPath)
  mkdirSync(dirname(worktree), { recursive: true })
  assertBranchRefMayBeCreated(ownPath, 'probe-writer')
  // branch-ref-guard: assertBranchRefMayBeCreated
  gitFixture(['worktree', 'add', '-b', 'probe-writer', worktree], ownPath)
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
  scratchDir: string,
  hubOpenMode?: string,
): Promise<CommandProbe> {
  const result = await startBounded(
    await sandboxLaunchArgv(profile, argv[0]!, argv.slice(1), scratchDir, environment),
    {
      budget: 'sandbox-probe',
      env: { ...process.env, ...environment },
    },
  )
  return {
    status: result.exitCode === 0 ? 'ran' : 'failed',
    reason: `exit ${result.exitCode ?? 'unknown'}${result.exitCode === 0 ? '' : `: ${firstErrorLine(result.stderr)}`}${hubOpenMode ? `; hub open mode: ${hubOpenMode}` : ''}`,
  }
}

function afterLaunchFixture(
  profile: ReturnType<typeof readonlyLensProfile>,
  targets: readonly AccessTarget[],
): AfterLaunchFixture | null {
  const target = targets.find(({ createAfterLaunch }) => createAfterLaunch)?.path
  if (!target) return null
  const markerRoot = profile.filesystem.allowWrite[0]!
  return {
    target,
    ready: join(markerRoot, '.confinement-probe-ready'),
    release: join(markerRoot, '.confinement-probe-release'),
  }
}

async function releaseAfterLaunchFixture(
  fixture: AfterLaunchFixture,
  running: ReturnType<typeof startBounded>,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(fixture.ready)) {
    if (Date.now() >= deadline) {
      writeFileSync(fixture.release, 'continue')
      await running
      throw new Error('filesystem probe did not signal launch')
    }
    await Bun.sleep(10)
  }
  mkdirSync(dirname(fixture.target), { recursive: true })
  writeFileSync(fixture.target, 'fixture')
  writeFileSync(fixture.release, 'continue')
}

async function runFilesystemAccessProbe(
  profile: ReturnType<typeof readonlyLensProfile>,
  targets: readonly AccessTarget[],
  environment: Record<string, string>,
  scratchDir: string,
) {
  const fixture = afterLaunchFixture(profile, targets)
  if (fixture) {
    rmSync(dirname(fixture.target), { recursive: true, force: true })
    rmSync(fixture.ready, { force: true })
    rmSync(fixture.release, { force: true })
  }
  try {
    const script = fixture
      ? '/usr/bin/touch "$1"\nwhile ! /bin/test -e "$2"; do /bin/sleep 0.01; done\nshift 2\nfor path\ndo\nif /bin/cat "$path" >/dev/null 2>&1; then echo readable; else echo denied; fi\ndone'
      : 'for path\ndo\nif /bin/cat "$path" >/dev/null 2>&1; then echo readable; else echo denied; fi\ndone'
    const argv = await sandboxLaunchArgv(
      profile,
      '/bin/sh',
      [
        '-c',
        script,
        'probe',
        ...(fixture ? [fixture.ready, fixture.release] : []),
        ...targets.map(({ path }) => path),
      ],
      scratchDir,
      environment,
    )
    const running = startBounded(argv, { budget: 'sandbox-probe' })
    if (fixture) await releaseAfterLaunchFixture(fixture, running)
    return await running
  } finally {
    if (fixture) {
      rmSync(dirname(fixture.target), { recursive: true, force: true })
      rmSync(fixture.ready, { force: true })
      rmSync(fixture.release, { force: true })
    }
  }
}

async function launchProbe(
  family: 'goose' | 'grok' | 'ACP writer' | 'workflow probe',
  profile: ReturnType<typeof readonlyLensProfile>,
  targets: readonly AccessTarget[],
  commandArgv: string[],
  environment: Record<string, string>,
  scratchDir: string,
  hubOpenMode: string,
): Promise<ConfinementFilesystemProbeRow> {
  try {
    const result = await runFilesystemAccessProbe(profile, targets, environment, scratchDir)
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
    const command = await launchCommand(profile, commandArgv, environment, scratchDir, hubOpenMode)
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
  scratchDir: string,
  hubOpenMode: string,
): Promise<ConfinementFilesystemProbeRow> {
  try {
    const targets: AccessTarget[] = [
      { name: 'install .env', path: installEnvPath, expected: 'denied' },
    ]
    const access = await launchCommand(
      profile,
      ['/bin/cat', installEnvPath],
      environment,
      scratchDir,
    )
    const version = await launchCommand(profile, [...cliArgv, '--version'], environment, scratchDir)
    const verb = await launchCommand(profile, commandArgv, environment, scratchDir, hubOpenMode)
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

async function launchExtractedRefGuardProbe(
  profile: ReturnType<typeof writerProfile>,
  worktree: string,
  scratchDir: string,
  environment: Record<string, string>,
): Promise<ConfinementFilesystemProbeRow> {
  const before = gitFixture(['rev-parse', 'HEAD'], worktree)
  const branch = gitFixture(['symbolic-ref', '--short', 'HEAD'], worktree)
  const guardEnvironment = prepareSharedRefGuard(worktree, `refs/heads/${branch}`)
  // Probe-only: production ACP commits are host-owned. These exact linked-worktree
  // metadata roots let this row prove that an extracted runtime asset executes
  // under the area deny for profiles (such as Codex in slice 2) that update refs in SRT.
  const refUpdateProfile = {
    ...profile,
    filesystem: {
      ...profile.filesystem,
      allowWrite: [
        ...profile.filesystem.allowWrite,
        worktreeGitDir(worktree),
        ...workerSharedGitRoots(worktree, branch),
      ],
    },
  }
  try {
    const result = await startBounded(
      await sandboxLaunchArgv(
        refUpdateProfile,
        'git',
        ['commit', '--allow-empty', '-m', 'probe'],
        scratchDir,
        environment,
      ),
      {
        budget: 'sandbox-probe',
        cwd: worktree,
        env: {
          ...process.env,
          ...environment,
          ...guardEnvironment,
          GIT_AUTHOR_NAME: 'Confinement Probe',
          GIT_AUTHOR_EMAIL: 'confinement-probe@example.invalid',
          GIT_COMMITTER_NAME: 'Confinement Probe',
          GIT_COMMITTER_EMAIL: 'confinement-probe@example.invalid',
          TMPDIR: scratchDir,
        },
      },
    )
    const after = gitFixture(['rev-parse', 'HEAD'], worktree)
    const committed = result.exitCode === 0 && before !== after
    return {
      family: 'extracted ref guard executes under the area deny',
      status: committed ? 'committed' : 'refused',
      paths: {},
      reason: committed
        ? undefined
        : `exit ${result.exitCode ?? 'unknown'}; ${stderrTail(result.stderr)}`,
    }
  } catch (error) {
    return {
      family: 'extracted ref guard executes under the area deny',
      status: 'refused',
      paths: {},
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
  const child = workerChildEnvironment({
    agent: BUILTIN_AGENTS.grok!,
    sandbox: 'srt',
    runRecordId: 'confinement-filesystem-probe',
    runToken: 'confinement-filesystem-probe-token',
    runNumber: 1,
    environment,
    stateEnvironment: environment,
    includeStore: true,
  })
  child.BOTTEGA_ORCHESTRATOR_DB = resolveOrchestratorDatabase(environment)
  return child
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

function probeAccessTargets(input: {
  ownPath: string
  worktree: string
  siblingWorktree: string
  siblingPath: string
  orchestratorDatabase: string
  orchestratorRuns: string
}): AccessTarget[] {
  const targets: AccessTarget[] = [
    { name: 'sibling .env', path: join(input.siblingPath, '.env'), expected: 'denied' },
    {
      name: 'sibling .mcp.json',
      path: join(input.siblingPath, '.mcp.json'),
      expected: 'denied',
    },
    { name: 'orchestrator store', path: input.orchestratorDatabase, expected: 'denied' },
    { name: 'own secret', path: join(input.ownPath, 'declared.secret'), expected: 'denied' },
    {
      name: 'same-project sibling worktree',
      path: join(input.siblingWorktree, '.env'),
      expected: 'denied',
    },
    {
      name: 'another run directory',
      path: join(input.orchestratorRuns, 'another-run', 'planted.txt'),
      expected: 'denied',
    },
    { name: 'own tree', path: join(input.worktree, 'visible.txt'), expected: 'readable' },
    {
      name: 'own .git objects',
      path: join(input.ownPath, '.git', 'objects', 'visible'),
      expected: 'readable',
    },
  ]
  if (process.platform === 'darwin') {
    targets.push({
      name: 'sibling tree created after launch',
      path: join(input.ownPath, '.claude', 'worktrees', 'created-after-launch', 'secret'),
      expected: 'denied',
      plant: false,
      createAfterLaunch: true,
    })
  }
  return targets
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
  const targets = probeAccessTargets({
    ownPath,
    worktree,
    siblingWorktree,
    siblingPath,
    orchestratorDatabase: state.orchestratorDatabase,
    orchestratorRuns: state.orchestratorRuns,
  })
  initializeProbeGitFixture(ownPath, worktree)
  for (const { path, plant = true } of targets) {
    if (!plant) continue
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
    const launch = (
      family: Parameters<typeof launchProbe>[0],
      profile: Parameters<typeof launchProbe>[1],
    ) =>
      launchProbe(
        family,
        profile,
        targets,
        commandArgv,
        environment,
        common.scratchDir,
        hubOpenMode,
      )
    return [
      await launch('goose', readonlyLensProfile({ ...common, agent: 'goose' })),
      await launch('grok', readonlyLensProfile({ ...common, agent: 'grok' })),
      await launch(
        'ACP writer',
        writerProfile({ ...common, agent: 'grok', askAddress: '127.0.0.1:1' }),
      ),
      await launchExtractedRefGuardProbe(
        writerProfile({ ...common, agent: 'grok', askAddress: '127.0.0.1:1' }),
        common.worktree,
        common.scratchDir,
        environment,
      ),
      await launch(
        'workflow probe',
        probeSandboxProfile({
          allowWriteDir: common.scratchDir,
          cwd: common.worktree,
          project: common.project,
          registeredProjects: common.registeredProjects,
          environment: common.environment,
          socketDenyPaths: common.socketDenyPaths,
        }),
      ),
      await launchCrossProjectCliProbe(
        readonlyLensProfile({ ...common, agent: 'grok' }),
        join(fixtureInstall.root, '.env'),
        cliArgv,
        commandArgv,
        environment,
        common.scratchDir,
        hubOpenMode,
      ),
      await launchCodexProbe(
        readonlyLensProfile({ ...common, agent: 'codex' }),
        targets,
        common.worktree,
        environment,
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
