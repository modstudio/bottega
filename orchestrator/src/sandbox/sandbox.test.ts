import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { fileBackedSecretPaths } from '../../../shared/file-backed-secret-paths.ts'
import { sourceBunExecutable } from '../../../shared/self-spawn.ts'
import {
  hubLoginTokenDirectory,
  recordSessionPath,
  resolveHubDatabase,
  resolveOrchestratorDatabase,
  resolveStatePaths,
  STATE_HOME_ENV,
} from '../../../shared/state-directory.ts'
import { workerHarnessName } from '../agent/worker-launch-env.ts'
import { ROOT } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import { resolveRunningInstallLayout, runningInstallReadCarveouts } from './install-read-policy.ts'
import {
  probeSandboxProfile as buildProbeSandboxProfile,
  readonlyLensProfile as buildReadonlyLensProfile,
  selectReadonlySandbox as buildReadonlySandboxSelection,
  writerProfile as buildWriterProfile,
  canonicalSocketDenyPaths,
  createSandboxRuntimeConfig,
  grokAskCommandFromConfig,
  grokAskServerCommand,
  grokSandboxConfig,
  prepareCodexHome,
  prepareGrokMcpHome,
  prepareSandboxHome,
  prepareWorkerHomeMirror,
  READONLY_LENS_DENY_PATHS,
  READONLY_LENS_DENY_WRITE_PATHS,
  readonlyLensDeniesLoginKeychain,
  readonlyLensDeniesOperatorEnvFile,
  readonlyLensReportInputs,
  removeNewSandboxHomeAfterFailure,
  resetSandbox,
  sandboxReasonPrefix,
  sandboxRuntimeConfig,
  withoutRegisteredOrchAskServer,
} from './sandbox.ts'

const fixtureProject = (settings: Project['settings'] = {}): Project => ({
  recordId: '01990000-0000-7000-8000-000000001214',
  name: 'fixture',
  path: '/projects/fixture',
  stack: 'node',
  canon: true,
  retiredAt: null,
  settings,
})

type AgentProfileInput<T> = Omit<T, 'registeredProjects' | 'orchestratorStoreAccess'> & {
  registeredProjects?: readonly Project[]
}
const withRegister = <
  T extends { project: Project | null; registeredProjects?: readonly Project[] },
>(
  input: T,
) => ({
  ...input,
  registeredProjects: input.registeredProjects ?? (input.project ? [input.project] : []),
  orchestratorStoreAccess: 'deny' as const,
})
const readonlyLensProfile = (
  input: AgentProfileInput<Parameters<typeof buildReadonlyLensProfile>[0]>,
) => buildReadonlyLensProfile(withRegister(input))
const writerProfile = (input: AgentProfileInput<Parameters<typeof buildWriterProfile>[0]>) =>
  buildWriterProfile(withRegister(input))
const probeSandboxProfile = (
  input: AgentProfileInput<Parameters<typeof buildProbeSandboxProfile>[0]>,
) => buildProbeSandboxProfile(withRegister(input))
const selectReadonlySandbox = (
  input: AgentProfileInput<Parameters<typeof buildReadonlySandboxSelection>[0]>,
) => buildReadonlySandboxSelection(withRegister(input))

test.each([
  {
    name: 'resolves a symlinked-parent path to its target',
    paths: ['/var/run/docker.sock'],
    resolved: { '/var/run': '/run' },
    expected: ['/run/docker.sock'],
  },
  {
    name: 'keeps a missing socket when its parent cannot be resolved',
    paths: ['/missing/docker.sock'],
    resolved: {},
    expected: ['/missing/docker.sock'],
  },
  {
    name: 'dedupes paths that resolve to one target',
    paths: ['/var/run/docker.sock', '/run/docker.sock'],
    resolved: {
      '/var/run': '/run',
      '/run': '/run',
    },
    expected: ['/run/docker.sock'],
  },
])('$name', ({ paths, resolved, expected }) => {
  expect(
    canonicalSocketDenyPaths(paths, (path) => resolved[path as keyof typeof resolved] ?? null),
  ).toEqual([...expected])
})

const TEST_SOCKET_DENY_PATHS = ['/test/run/docker.sock', '/test/custom/docker.sock'] as const

test('confinement report inputs use the injected socket denies', () => {
  const environment = {
    HOME: '/Users/operator',
    [STATE_HOME_ENV]: '/operator/state',
    [CONFIG_HOME_ENV]: '/operator/config',
  }

  expect(readonlyLensReportInputs(environment, null, TEST_SOCKET_DENY_PATHS).denyRead).toEqual(
    expect.arrayContaining(TEST_SOCKET_DENY_PATHS),
  )
})

const temporaryDirectories: string[] = []
const temporaryState = () => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-sandbox-state-'))
  temporaryDirectories.push(directory)
  return directory
}

test('every SRT profile construction routes through the one mandatory-deny constructor', () => {
  const sources = [...new Bun.Glob('**/*.ts').scanSync({ cwd: join(ROOT, 'src') })]
    .filter((path) => !path.endsWith('.test.ts'))
    .map((path) => [path, readFileSync(join(ROOT, 'src', path), 'utf8')] as const)
  const constructors = sources
    .filter(([, source]) => /createSandboxRuntimeConfig\(\s*\{/.test(source))
    .map(([path]) => path)
    .sort()
  const definitions = sources.filter(([, source]) =>
    source.includes('export function createSandboxRuntimeConfig('),
  )

  expect(constructors).toEqual(['issue/issue-shell.ts', 'sandbox/sandbox.ts'])
  expect(definitions.map(([path]) => path)).toEqual(['sandbox/sandbox.ts'])
})

test('every SRT profile denies every file-backed secret path', () => {
  const environment = {
    [CONFIG_HOME_ENV]: '/operator/config',
    [STATE_HOME_ENV]: '/operator/state',
  }
  const profile = createSandboxRuntimeConfig(
    {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowUnixSockets: [],
        allowLocalBinding: false,
      },
      filesystem: { denyRead: [], allowWithinDeny: [], allowWrite: [], denyWrite: [] },
    },
    environment,
  )

  expect(profile.filesystem.denyRead).toEqual(
    expect.arrayContaining(fileBackedSecretPaths(environment)),
  )
  const staging = join(recordSessionPath(environment), '..', '.session-staging')
  expect(profile.filesystem.denyRead.some((path) => staging.startsWith(`${path}/`))).toBe(true)
})

test('prepares one persistent Grok MCP home and refuses a source clamp', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-grok-home-'))
  try {
    const source = join(fixture, 'source')
    const runDir = join(fixture, 'run')
    mkdirSync(source)
    writeFileSync(
      join(source, 'config.toml'),
      `model = "grok"\n[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "orch"\n` +
        `[mcp_servers.${WORKER_MCP_SERVER_NAME}]\ncommand = "/old/bun"\nargs = ["/main/orchestrator/src/cli.ts", "ask-server"]\n` +
        `[mcp_servers.${WORKER_MCP_SERVER_NAME}.env]\nSTALE = "1"\n`,
    )
    expect(prepareGrokMcpHome(runDir, ['stopal', 'alephbeis'], source, 'host')).toEqual({
      GROK_HOME: runDir,
      GROK_DISABLE_AUTOUPDATER: '1',
    })
    const written = readFileSync(join(runDir, 'config.toml'), 'utf8')
    expect(written.startsWith('disabled_mcp_servers = ["stopal","alephbeis"]\n\n')).toBe(true)
    expect(written).toContain(`model = "grok"\n[mcp_servers.${MCP_SERVER_NAME}]`)
    expect(written).not.toContain('/main/orchestrator/src/cli.ts')
    expect(written).not.toContain('STALE')
    expect(written).toContain(`command = ${JSON.stringify(join(ROOT, '..', 'bin', PLATFORM_SLUG))}`)
    expect(written).toContain('args = ["mcp","ask-server"]')
    writeFileSync(join(source, 'config.toml'), 'replacement = true\n')
    prepareGrokMcpHome(runDir, [], source, 'srt')
    const sandboxed = readFileSync(join(runDir, 'config.toml'), 'utf8')
    expect(grokAskCommandFromConfig(sandboxed)).toEqual(grokAskServerCommand('srt'))
    expect(withoutRegisteredOrchAskServer(sandboxed)).toBe(withoutRegisteredOrchAskServer(written))
    prepareGrokMcpHome(runDir, [], source, 'host')
    const hostedAgain = readFileSync(join(runDir, 'config.toml'), 'utf8')
    expect(grokAskCommandFromConfig(hostedAgain)).toEqual(grokAskServerCommand('host'))
    expect(withoutRegisteredOrchAskServer(hostedAgain)).toBe(
      withoutRegisteredOrchAskServer(sandboxed),
    )
    const conflict = join(fixture, 'conflict')
    mkdirSync(conflict)
    writeFileSync(
      join(conflict, 'config.toml'),
      `disabled_mcp_servers = ["x"]\n[mcp_servers.${MCP_SERVER_NAME}]\n`,
    )
    expect(() => prepareGrokMcpHome(join(fixture, 'conflict-run'), [], conflict, 'host')).toThrow(
      `disabled_mcp_servers is already declared in ${join(conflict, 'config.toml')}`,
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('reads the configured Grok ask command from the table its writer owns', () => {
  expect(
    grokAskCommandFromConfig(
      `model = "grok"\n[mcp_servers.${WORKER_MCP_SERVER_NAME}]\ncommand = "/stale/bun"\n` +
        'args = ["/stale/orch.ts", "ask-server"]\n[ui]\ncommand = "ignored"\n',
    ),
  ).toEqual(['/stale/bun', '/stale/orch.ts', 'ask-server'])
})

test('chooses the Grok ask command from the launch sandbox', () => {
  expect(grokAskServerCommand('srt')).toEqual([
    sourceBunExecutable(),
    '--no-env-file',
    join(ROOT, 'src', 'ask', 'ask-proxy.ts'),
    'ask-server',
  ])
  expect(grokAskServerCommand('host')).toEqual([
    join(ROOT, '..', 'bin', PLATFORM_SLUG),
    'mcp',
    'ask-server',
  ])
})

test('prepares and updates a Grok home for the launch sandbox only', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-grok-sandbox-command-'))
  try {
    const operator = join(fixture, 'operator')
    const runDir = join(fixture, 'run')
    mkdirSync(join(operator, '.grok'), { recursive: true })
    writeFileSync(
      join(operator, '.grok', 'config.toml'),
      'model = "grok"\ndisabled_mcp_servers = ["kept"]\n[mcp_servers.other]\ncommand = "kept"\n',
    )

    prepareSandboxHome('grok', runDir, { HOME: operator }, 'host')
    const host = readFileSync(join(runDir, 'config.toml'), 'utf8')
    expect(grokAskCommandFromConfig(host)).toEqual(grokAskServerCommand('host'))

    prepareSandboxHome('grok', runDir, { HOME: operator }, 'srt')
    const srt = readFileSync(join(runDir, 'config.toml'), 'utf8')
    expect(grokAskCommandFromConfig(srt)).toEqual(grokAskServerCommand('srt'))
    expect(withoutRegisteredOrchAskServer(srt)).toBe(withoutRegisteredOrchAskServer(host))

    prepareSandboxHome('grok', runDir, { HOME: operator }, 'host')
    const hostAgain = readFileSync(join(runDir, 'config.toml'), 'utf8')
    expect(grokAskCommandFromConfig(hostAgain)).toEqual(grokAskServerCommand('host'))
    expect(withoutRegisteredOrchAskServer(hostAgain)).toBe(withoutRegisteredOrchAskServer(srt))
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('mirrors operator tooling into a worker HOME without harness homes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-worker-home-'))
  try {
    const operatorHome = join(fixture, 'operator')
    const runDir = join(fixture, 'sandbox-42')
    mkdirSync(operatorHome)
    mkdirSync(join(operatorHome, '.claude', 'rules'), { recursive: true })
    mkdirSync(join(operatorHome, 'dotfiles', '.claude'), { recursive: true })
    writeFileSync(join(operatorHome, '.claude', '.env'), 'MCP_TOKEN=secret\n')
    writeFileSync(join(operatorHome, '.claude', 'CLAUDE.md'), 'Architect instructions.\n')
    writeFileSync(join(operatorHome, '.claude', 'rules', 'canon.md'), 'Architect canon.\n')
    writeFileSync(join(operatorHome, '.claude', 'settings.json'), '{}\n')
    writeFileSync(join(operatorHome, '.claude.json'), '{}')
    symlinkSync(join(operatorHome, '.claude'), join(operatorHome, 'linked-claude'))
    for (const name of ['.codex', '.grok', '.bun', '.gitconfig', '.ssh'])
      writeFileSync(join(operatorHome, name), '', { flag: 'a' })
    const workerHome = prepareWorkerHomeMirror(runDir, operatorHome)
    for (const linked of ['.bun', '.gitconfig', '.ssh']) {
      expect(lstatSync(join(workerHome, linked)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(workerHome, linked))).toBe(join(operatorHome, linked))
    }
    const workerClaudeHome = join(workerHome, '.claude')
    expect(lstatSync(workerClaudeHome).isDirectory()).toBe(true)
    expect(lstatSync(workerClaudeHome).isSymbolicLink()).toBe(false)
    expect(statSync(workerClaudeHome).mode & 0o777).toBe(0o700)
    expect(readdirSync(workerClaudeHome)).toEqual(['.env'])
    expect(lstatSync(join(workerClaudeHome, '.env')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(workerClaudeHome, '.env'))).toBe(join(operatorHome, '.claude', '.env'))
    for (const omitted of ['.claude.json', '.codex', '.grok', 'dotfiles', 'linked-claude']) {
      expect(existsSync(join(workerHome, omitted))).toBe(false)
    }
    expect(statSync(runDir).mode & 0o777).toBe(0o700)
    expect(statSync(workerHome).mode & 0o777).toBe(0o700)
    expect(prepareWorkerHomeMirror(runDir, operatorHome)).toBe(workerHome)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('worker HOME omits the Claude env link when its source is missing or non-regular', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-worker-home-claude-env-'))
  try {
    const operatorHome = join(fixture, 'operator')
    const operatorClaudeHome = join(operatorHome, '.claude')
    mkdirSync(operatorClaudeHome, { recursive: true })

    const missingHome = prepareWorkerHomeMirror(join(fixture, 'missing-run'), operatorHome)
    expect(readdirSync(join(missingHome, '.claude'))).toEqual([])

    mkdirSync(join(operatorClaudeHome, '.env'))
    const nonRegularHome = prepareWorkerHomeMirror(join(fixture, 'non-regular-run'), operatorHome)
    expect(readdirSync(join(nonRegularHome, '.claude'))).toEqual([])
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('worker HOME removes a resumed Claude env link when its source becomes non-regular', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-worker-home-claude-env-resume-'))
  try {
    const operatorHome = join(fixture, 'operator')
    const operatorClaudeHome = join(operatorHome, '.claude')
    const sourceClaudeEnv = join(operatorClaudeHome, '.env')
    const runDir = join(fixture, 'run')
    const replacement = join(fixture, 'replacement.env')
    mkdirSync(operatorClaudeHome, { recursive: true })
    writeFileSync(sourceClaudeEnv, 'MCP_TOKEN=original\n')
    writeFileSync(replacement, 'MCP_TOKEN=replacement\n')

    const workerHome = prepareWorkerHomeMirror(runDir, operatorHome)
    rmSync(sourceClaudeEnv)
    symlinkSync(replacement, sourceClaudeEnv)

    prepareWorkerHomeMirror(runDir, operatorHome)
    expect(
      lstatSync(join(workerHome, '.claude', '.env'), { throwIfNoEntry: false }),
    ).toBeUndefined()
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('worker HOME repairs a resumed Claude env target replaced by a worker', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-worker-home-claude-env-repair-'))
  try {
    const operatorHome = join(fixture, 'operator')
    const sourceClaudeEnv = join(operatorHome, '.claude', '.env')
    const runDir = join(fixture, 'run')
    const replacement = join(fixture, 'replacement.env')
    mkdirSync(join(operatorHome, '.claude'), { recursive: true })
    writeFileSync(sourceClaudeEnv, 'MCP_TOKEN=original\n')
    writeFileSync(replacement, 'MCP_TOKEN=replacement\n')

    const workerHome = prepareWorkerHomeMirror(runDir, operatorHome)
    const targetClaudeEnv = join(workerHome, '.claude', '.env')
    rmSync(targetClaudeEnv)
    symlinkSync(replacement, targetClaudeEnv)

    prepareWorkerHomeMirror(runDir, operatorHome)
    expect(lstatSync(targetClaudeEnv).isSymbolicLink()).toBe(true)
    expect(readlinkSync(targetClaudeEnv)).toBe(sourceClaudeEnv)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('harness aliases prepare the Codex and Grok chain homes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-worker-alias-home-'))
  try {
    const operatorHome = join(fixture, 'operator')
    mkdirSync(join(operatorHome, '.codex'), { recursive: true })
    mkdirSync(join(operatorHome, '.grok'))
    writeFileSync(join(operatorHome, '.codex', 'auth.json'), '{}')
    writeFileSync(join(operatorHome, '.codex', 'config.toml'), '')
    const environment = { HOME: operatorHome }
    const codex = prepareSandboxHome(
      workerHarnessName({ name: 'registered-codex', harness: 'codex' }),
      join(fixture, 'codex-run'),
      environment,
      'host',
    )
    const grok = prepareSandboxHome(
      workerHarnessName({ name: 'registered-grok', harness: 'grok' }),
      join(fixture, 'grok-run'),
      environment,
      'srt',
    )
    const goose = prepareSandboxHome(
      workerHarnessName({ name: 'registered-goose', harness: 'goose' }),
      join(fixture, 'goose-run'),
      environment,
      'srt',
    )
    expect(codex.CODEX_HOME).toBe(join(fixture, 'codex-run', 'codex'))
    expect(grok.GROK_HOME).toBe(join(fixture, 'grok-run'))
    expect(grok.HOME).toBe(join(fixture, 'grok-run', 'home'))
    expect(goose.HOME).toBe(join(fixture, 'goose-run', 'home'))
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('failed home setup or MCP preflight removes only a newly created chain directory', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-worker-home-failure-'))
  try {
    const grokSource = join(fixture, 'operator-grok')
    mkdirSync(grokSource)
    writeFileSync(join(grokSource, 'config.toml'), 'disabled_mcp_servers = []\n')
    const failedSetup = join(fixture, 'home-setup')
    try {
      prepareGrokMcpHome(failedSetup, [], grokSource, 'host')
    } catch {
      removeNewSandboxHomeAfterFailure(failedSetup, false)
    }
    expect(existsSync(failedSetup)).toBe(false)

    const codexSource = join(fixture, 'operator-codex')
    mkdirSync(codexSource)
    writeFileSync(join(codexSource, 'auth.json'), '{}')
    writeFileSync(join(codexSource, 'config.toml'), '')
    const failedPreflight = join(fixture, 'MCP-preflight')
    try {
      prepareCodexHome(failedPreflight, { CODEX_HOME: codexSource })
      await Promise.reject(new Error('MCP preflight'))
    } catch {
      removeNewSandboxHomeAfterFailure(failedPreflight, false)
    }
    expect(existsSync(failedPreflight)).toBe(false)

    const reused = join(fixture, 'reused')
    mkdirSync(reused)
    removeNewSandboxHomeAfterFailure(reused, true)
    expect(existsSync(reused)).toBe(true)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('worker HOME refuses an unreadable operator path with a remedy', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-worker-home-refusal-'))
  try {
    const missing = join(fixture, 'missing')
    expect(() => prepareWorkerHomeMirror(join(fixture, 'run'), missing)).toThrow(
      `worker HOME refusal: could not list ${missing}`,
    )
    expect(() => prepareWorkerHomeMirror(join(fixture, 'run'), missing)).toThrow(
      'set HOME to a readable operator home and retry',
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('readonlyLensDeniesOperatorEnvFile follows the denyRead list, not a tilde-path constant', () => {
  expect(
    readonlyLensDeniesOperatorEnvFile(
      ['/operator/.claude/.env', '/operator/.ssh'],
      ['/operator/.claude/.env'],
    ),
  ).toBe(true)
  expect(readonlyLensDeniesOperatorEnvFile(['/operator/.ssh'], ['/operator/.claude/.env'])).toBe(
    false,
  )
})

test('readonlyLensDeniesLoginKeychain follows the denyRead list, not a keychain substring', () => {
  expect(
    readonlyLensDeniesLoginKeychain(
      ['/operator/Library/Keychains/login.keychain-db'],
      ['/operator/Library/Keychains/login.keychain-db'],
    ),
  ).toBe(true)
  expect(
    readonlyLensDeniesLoginKeychain(
      ['/operator/.ssh'],
      ['/operator/Library/Keychains/login.keychain'],
    ),
  ).toBe(false)
})

test('probe sandbox profile denies network and writes except the throwaway directory', () => {
  const scratch = '/tmp/orch-probe-scratch'
  const profile = probeSandboxProfile({
    allowWriteDir: scratch,
    cwd: '/projects/fixture',
    project: fixtureProject(),
    socketDenyPaths: TEST_SOCKET_DENY_PATHS,
  })
  expect(profile.network.allowedDomains).toEqual([])
  expect(profile.network.allowUnixSockets).toEqual([])
  expect(profile.network.allowLocalBinding).toBe(false)
  expect(profile.filesystem.allowWrite).toEqual([resolve(scratch)])
  expect(profile.filesystem.denyRead).toEqual(
    expect.arrayContaining([
      ...READONLY_LENS_DENY_PATHS.map((path) => path.replace(/^~/, homedir())),
      ...TEST_SOCKET_DENY_PATHS,
    ]),
  )
})

test('probe sandbox profile denies a project-declared secret path', () => {
  const profile = probeSandboxProfile({
    allowWriteDir: '/tmp/orch-probe-scratch',
    cwd: '/projects/fixture',
    project: fixtureProject({ secretPaths: ['/operator/project-secret'] }),
  })
  expect(profile.filesystem.denyRead).toContain('/operator/project-secret')
})

describe('readonly-lens sandbox profile', () => {
  const originalStateHome = process.env[STATE_HOME_ENV]
  beforeEach(() => {
    process.env[STATE_HOME_ENV] = temporaryState()
  })
  afterEach(async () => {
    await resetSandbox()
    if (originalStateHome === undefined) delete process.env[STATE_HOME_ENV]
    else process.env[STATE_HOME_ENV] = originalStateHome
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  test(`replaces a stale registered Grok ${WORKER_MCP_SERVER_NAME} entry with this checkout proxy`, () => {
    const config = `[mcp_servers.${WORKER_MCP_SERVER_NAME}]\ncommand = "bun"\nargs = ["/main/orchestrator/src/cli.ts", "ask-server"]\n`
    const rewritten = grokSandboxConfig(config, 'srt')
    expect(rewritten).toContain(`command = ${JSON.stringify(sourceBunExecutable())}`)
    expect(rewritten).toContain('"ask-server"')
    expect(rewritten).not.toContain('/main/orchestrator/src/cli.ts')
    expect(rewritten).toContain('/orchestrator/src/ask/ask-proxy.ts')
  })
  test(`keeps every other table, array tables included, around the replaced ${WORKER_MCP_SERVER_NAME}`, () => {
    const config =
      '[cli]\na = 1\n[marketplace]\nb = 2\n[[marketplace.sources]]\nurl = "before"\n' +
      `[mcp_servers.${WORKER_MCP_SERVER_NAME}]\ncommand = "x"\n[mcp_servers.${WORKER_MCP_SERVER_NAME}.env]\nK = "v"\n` +
      '[[marketplace.sources]]\nurl = "after"\n[ui]\nc = 3\n'
    const rewritten = grokSandboxConfig(config, 'srt')
    for (const kept of ['[cli]', '[marketplace]', 'url = "before"', 'url = "after"', '[ui]']) {
      expect(rewritten).toContain(kept)
    }
    expect(rewritten.match(/\[\[marketplace\.sources\]\]/g)?.length).toBe(2)
    expect(rewritten).not.toContain('command = "x"')
    expect(rewritten).not.toContain('K = "v"')
  })
  test(`adds a live ${WORKER_MCP_SERVER_NAME} table when the user config has none`, () => {
    const rewritten = grokSandboxConfig('model = "grok"\n', 'srt')
    expect(rewritten).toContain('model = "grok"')
    expect(rewritten).toContain(`[mcp_servers.${WORKER_MCP_SERVER_NAME}]`)
    expect(rewritten).toContain('/orchestrator/src/ask/ask-proxy.ts')
  })
  test('builds allow and deny lists from the register fixture', () => {
    const state = temporaryState()
    const environment = {
      HOME: '/Users/operator',
      [STATE_HOME_ENV]: state,
      [CONFIG_HOME_ENV]: '/Users/operator/.config/platform',
      [HARNESS_ENV_FILE_ENV]: '',
    }
    const project = fixtureProject({
      secretPaths: ['/shared/absolute.secret', '~/.tokens/private', 'config/operator.secret'],
    })
    const profile = readonlyLensProfile({
      worktree: '/runs/tree',
      runtimeDir: '/runs/evidence',
      project,
      agent: 'grok',
      baseUrl: 'https://openrouter.ai/api/v1',
      path: '/opt/toolchain/bin:/usr/bin',
      nodeModuleLinks: ['/projects/fixture/node_modules'],
      environment,
      socketDenyPaths: TEST_SOCKET_DENY_PATHS,
    })

    expect(profile.filesystem.denyRead).toEqual([
      ...READONLY_LENS_DENY_PATHS.map((path) => path.replace(/^~/, homedir())),
      ...fileBackedSecretPaths(environment),
      state,
      join(state, 'orchestrator'),
      join(state, 'orchestrator', 'orchestrator.db'),
      join(state, 'orchestrator', 'runs'),
      '/projects',
      '/projects/fixture/.claude/worktrees',
      join('/Users/operator/.config/platform', `${PLATFORM_SLUG}.env`),
      '/shared/absolute.secret',
      join(homedir(), '.tokens/private'),
      '/projects/fixture/config/operator.secret',
      ...TEST_SOCKET_DENY_PATHS,
    ])
    expect(profile.filesystem.allowWithinDeny).toEqual([
      '/runs/tree',
      '/runs/evidence',
      '/runs/evidence/harness',
      resolveHubDatabase(environment),
      `${resolveHubDatabase(environment)}-wal`,
      `${resolveHubDatabase(environment)}-shm`,
      '/projects/fixture/.git',
      '/opt/toolchain/bin',
      '/usr/bin',
      '/projects/fixture/node_modules',
      join(homedir(), '.claude.json'),
      process.execPath,
      ...runningInstallReadCarveouts(resolveRunningInstallLayout(environment)),
    ])
    expect(profile.filesystem.allowWrite).toEqual(['/runs/tree', '/runs/evidence'])
    expect(profile.filesystem.denyWrite).toEqual(['/tmp/claude', '/private/tmp/claude'])
    expect(profile.filesystem.allowWrite).not.toContain(hubLoginTokenDirectory(environment))
    expect(profile.network.allowedDomains).toEqual([
      'cli-chat-proxy.grok.com',
      'auth.x.ai',
      'api.x.ai',
      'openrouter.ai',
      'localhost',
      '127.0.0.1',
      '[::1]',
    ])
    expect(profile.network.allowUnixSockets).toEqual([])
    expect(profile.network.allowLocalBinding).toBe(true)
    expect(profile.enableWeakerNetworkIsolation).toBe(true)
  })

  test('area policy denies the state root and sibling checkout while carving back owned paths', () => {
    const state = temporaryState()
    const environment = { HOME: '/Users/operator', [STATE_HOME_ENV]: state }
    const own = fixtureProject({ secretPaths: ['config/operator.secret'] })
    const sibling = {
      ...fixtureProject(),
      recordId: 'sibling-id',
      name: 'sibling',
      path: '/projects/sibling',
    }
    const profile = readonlyLensProfile({
      worktree: '/projects/fixture/.claude/worktrees/run',
      runtimeDir: join(state, 'orchestrator/runs/sandbox-run'),
      scratchDir: join(state, 'orchestrator/runs/run/scratch'),
      project: own,
      registeredProjects: [own, sibling],
      agent: 'grok',
      path: '/usr/bin',
      nodeModuleLinks: [],
      environment,
      socketDenyPaths: [],
    })

    expect(profile.filesystem.denyRead).toContain(resolveStatePaths(environment).root)
    expect(profile.filesystem.denyRead).toContain(resolveOrchestratorDatabase(environment))
    expect(profile.filesystem.allowWithinDeny).not.toContain(
      resolveOrchestratorDatabase(environment),
    )
    expect(profile.filesystem.denyRead).toContain('/projects/sibling')
    expect(profile.filesystem.denyRead).toContain('/projects/fixture/.claude/worktrees')
    expect(profile.filesystem.denyRead).toContain('/projects/sibling/.claude/worktrees')
    expect(profile.filesystem.denyRead).toContain('/projects/fixture/config/operator.secret')
    for (const allowed of [
      '/projects/fixture/.claude/worktrees/run',
      join(state, 'orchestrator/runs/run'),
      join(state, 'orchestrator/runs/run/scratch'),
      join(state, 'orchestrator/runs/sandbox-run'),
      join(state, 'orchestrator/runs/sandbox-run/harness'),
      resolveHubDatabase(environment),
      `${resolveHubDatabase(environment)}-wal`,
      `${resolveHubDatabase(environment)}-shm`,
      '/projects/fixture/.git',
    ]) {
      expect(profile.filesystem.allowWithinDeny).toContain(allowed)
    }
    expect(profile.filesystem.allowWithinDeny).not.toContain(
      '/projects/fixture/config/operator.secret',
    )
  })

  test('sandbox selection removes the shared reader worktree from writable roots', () => {
    const selected = selectReadonlySandbox({
      agent: 'grok',
      readsRepo: true,
      writesRepo: false,
      worktree: '/runs/tree',
      runtimeDir: '/runs/evidence',
      scratchDir: '/runs/scratch',
      project: fixtureProject(),
      path: '/usr/bin',
      sharedReader: true,
    })
    expect(selected.sandbox).toBe('srt')
    expect(selected.profile?.filesystem.allowWrite).toEqual(['/runs/evidence', '/runs/scratch'])
    expect(selected.profile?.filesystem.allowWrite).not.toContain('/runs/tree')

    const own = selectReadonlySandbox({
      agent: 'grok',
      readsRepo: true,
      writesRepo: false,
      worktree: '/runs/tree',
      runtimeDir: '/runs/evidence',
      scratchDir: '/runs/scratch',
      project: fixtureProject(),
      path: '/usr/bin',
    })
    expect(own.profile?.filesystem.allowWrite).toContain('/runs/tree')
  })

  test('profile construction includes the exact token-directory deny without creating it', () => {
    const environment = {
      HOME: homedir(),
      [STATE_HOME_ENV]: temporaryState(),
      [HARNESS_ENV_FILE_ENV]: '',
    }
    const directory = hubLoginTokenDirectory(environment)
    expect(existsSync(directory)).toBe(false)

    const input = {
      worktree: '/runs/tree',
      runtimeDir: '/runs/evidence',
      agent: 'grok',
      project: fixtureProject(),
      path: '/usr/bin',
      nodeModuleLinks: [],
      environment,
    }
    const first = readonlyLensProfile(input)
    expect(first.filesystem.denyRead.filter((path) => path === directory)).toEqual([directory])
    expect(existsSync(directory)).toBe(false)
  })

  test('a registered exact deny removes an otherwise allowed read', () => {
    const claudeConfig = join(homedir(), '.claude.json')
    const profile = readonlyLensProfile({
      worktree: '/runs/tree',
      runtimeDir: '/runs/evidence',
      agent: 'grok',
      project: fixtureProject({ secretPaths: [claudeConfig] }),
      path: '/usr/bin',
      nodeModuleLinks: [],
    })
    expect(profile.filesystem.denyRead).toContain(claudeConfig)
    expect(profile.filesystem.allowWithinDeny).not.toContain(claudeConfig)
  })

  test('a denied parent removes an allowed linked dependency child', () => {
    const profile = readonlyLensProfile({
      worktree: '/runs/tree',
      runtimeDir: '/runs/evidence',
      agent: 'grok',
      project: fixtureProject({ secretPaths: ['/projects/fixture/dependencies'] }),
      path: '/usr/bin',
      nodeModuleLinks: ['/projects/fixture/dependencies/node_modules'],
    })
    expect(profile.filesystem.allowWithinDeny).not.toContain(
      '/projects/fixture/dependencies/node_modules',
    )
  })

  test('a registered secret inside the worktree refuses the profile', () => {
    expect(() =>
      readonlyLensProfile({
        worktree: '/runs/tree',
        runtimeDir: '/runs/evidence',
        agent: 'grok',
        project: fixtureProject({ secretPaths: ['/runs/tree/private/token'] }),
        path: '/usr/bin',
        nodeModuleLinks: [],
      }),
    ).toThrow('a registered secret path cannot be inside the worktree')
  })

  test('a registered secret inside the runs directory refuses', () => {
    expect(() =>
      readonlyLensProfile({
        worktree: '/runs/tree',
        runtimeDir: '/runs/evidence',
        agent: 'grok',
        project: fixtureProject({ secretPaths: ['/runs/evidence/private/token'] }),
        path: '/usr/bin',
        nodeModuleLinks: [],
      }),
    ).toThrow('a registered secret path cannot be inside the run directory')
  })

  test('maps every profile rule to the sandbox-runtime config', () => {
    const profile = readonlyLensProfile({
      worktree: '/runs/tree',
      runtimeDir: '/runs/evidence',
      agent: 'grok',
      project: fixtureProject(),
      path: '/usr/bin',
      nodeModuleLinks: [],
    })
    profile.network.allowUnixSockets.push('/runs/evidence/grok-leader.sock')
    expect(profile.enableWeakerNetworkIsolation).toBe(false)
    expect(sandboxRuntimeConfig(profile)).toEqual({
      ...profile,
      enableWeakerNetworkIsolation: false,
      filesystem: {
        denyRead: profile.filesystem.denyRead,
        allowRead: profile.filesystem.allowWithinDeny,
        allowWrite: profile.filesystem.allowWrite,
        denyWrite: profile.filesystem.denyWrite,
      },
    })
  })

  test('a remote HTTPS agent endpoint records weaker isolation on the srt selection', () => {
    const selected = selectReadonlySandbox({
      agent: 'goose-openrouter',
      readsRepo: true,
      writesRepo: false,
      worktree: '/runs/tree',
      runtimeDir: '/runs/evidence',
      project: fixtureProject(),
      path: '/usr/bin',
      baseUrl: 'https://openrouter.ai/api/v1',
    })
    expect(selected.sandbox).toBe('srt')
    expect(selected.profile?.enableWeakerNetworkIsolation).toBe(true)
    expect(selected.reason).toBe(
      'weaker network isolation enabled: remote HTTPS endpoint openrouter.ai ' +
        'requires macOS trustd for TLS verification',
    )
    expect(sandboxReasonPrefix(selected.sandbox)).toBe('sandbox')
  })

  test('a read-only sandbox profile denies every injected Docker socket path', () => {
    const selected = selectReadonlySandbox({
      agent: 'grok',
      readsRepo: true,
      writesRepo: false,
      worktree: '/runs/tree',
      runtimeDir: '/runs/evidence',
      project: fixtureProject(),
      path: '/usr/bin',
      environment: {
        HOME: homedir(),
        [STATE_HOME_ENV]: temporaryState(),
        [CONFIG_HOME_ENV]: '/Users/operator/.config/platform',
        [HARNESS_ENV_FILE_ENV]: '',
        DOCKER_HOST: 'unix:///custom/docker.sock',
      },
      socketDenyPaths: TEST_SOCKET_DENY_PATHS,
    })

    expect(selected.sandbox).toBe('srt')
    expect(selected.reason).toBeNull()
    expect(selected.profile?.enableWeakerNetworkIsolation).toBe(false)
    expect(selected.profile?.filesystem.denyRead).toEqual(
      expect.arrayContaining(READONLY_LENS_DENY_PATHS.map((path) => path.replace(/^~/, homedir()))),
    )
    for (const socket of TEST_SOCKET_DENY_PATHS) {
      expect(selected.profile?.filesystem.denyRead).toContain(socket)
    }
    expect(selected.profile?.network.allowUnixSockets).toEqual([])
  })

  test('a writer grants only its tree, scratch, and harness state, and denies host state', () => {
    const profile = writerProfile({
      worktree: '/projects/main/.claude/worktrees/run-42',
      runtimeDir: '/state/runs/sandbox-root',
      scratchDir: '/state/runs/run-42/scratch',
      askAddress: '127.0.0.1:43127',
      project: fixtureProject(),
      agent: 'goose-openrouter',
      path: '/usr/bin',
      nodeModuleLinks: [],
      socketDenyPaths: TEST_SOCKET_DENY_PATHS,
    })

    expect(profile.filesystem.allowWrite).toEqual([
      '/projects/main/.claude/worktrees/run-42',
      '/state/runs/run-42/scratch',
      '/state/runs/sandbox-root/harness',
    ])
    expect(profile.filesystem.allowWrite).not.toContain('/state/runs/sandbox-root')
    expect(profile.filesystem.allowWrite).not.toContain('/state/runs/sandbox-root/checkpoint-hooks')
    expect(profile.filesystem.allowWrite).not.toContain('/state/runs')
    expect(profile.filesystem.allowWrite).not.toContain('/state/runs/run-41')
    expect(profile.filesystem.allowWrite).not.toContain('/projects/main')
    expect(profile.filesystem.allowWrite).not.toContain('/projects/main/.git/objects')
    expect(profile.filesystem.denyWrite).toContain('/projects/main/.claude/worktrees/run-42/.git')
    expect(profile.filesystem.denyRead).toEqual(expect.arrayContaining(TEST_SOCKET_DENY_PATHS))
    for (const path of READONLY_LENS_DENY_WRITE_PATHS) {
      expect(profile.filesystem.denyWrite).not.toContain(path)
    }
    expect(profile.network.allowedDomains).toContain('127.0.0.1:43127')
    expect(profile.network.allowedDomains).not.toContain('127.0.0.1')
    expect(profile.network.allowLocalBinding).toBe(false)
  })

  test('a writing ACP run cannot bypass an unavailable sandbox through the host', () => {
    expect(() =>
      selectReadonlySandbox({
        agent: 'goose-openrouter',
        readsRepo: true,
        writesRepo: true,
        writingAcp: true,
        override: 'host',
        worktree: '/runs/tree',
        runtimeDir: '/runs/evidence',
        scratchDir: '/runs/evidence/scratch',
        askAddress: '127.0.0.1:43127',
        project: fixtureProject(),
      }),
    ).toThrow('cannot bypass srt')
  })

  test('an MCP Grok repository run is unconfined because srt blocks its transports', () => {
    expect(
      selectReadonlySandbox({
        agent: 'grok',
        readsRepo: true,
        writesRepo: false,
        mcp: true,
        worktree: '/runs/tree',
        runtimeDir: '/runs/evidence',
        project: fixtureProject(),
      }),
    ).toEqual({
      sandbox: 'host',
      profile: null,
      reason: 'MCP was requested; srt blocks MCP transports; run is unconfined',
    })
  })

  test('Grok repository runs without MCP remain confined', () => {
    const selections = [{}, { mcp: false }].map((mcp) =>
      selectReadonlySandbox({
        agent: 'grok',
        readsRepo: true,
        writesRepo: false,
        ...mcp,
        worktree: '/runs/tree',
        runtimeDir: '/runs/evidence',
        project: fixtureProject(),
        path: '/usr/bin',
      }),
    )
    for (const selected of selections) {
      expect(selected.sandbox).toBe('srt')
      expect(selected.profile).not.toBeNull()
    }
    expect(selections[0]).toEqual(selections[1])
  })

  test('a no-repo Grok run uses its isolate as the sandbox root', () => {
    const selected = selectReadonlySandbox({
      agent: 'grok',
      readsRepo: false,
      writesRepo: false,
      worktree: '/runs/isolates/42',
      runtimeDir: '/runs/sandbox-42',
      scratchDir: '/runs/42/scratch',
      project: fixtureProject(),
      path: '/usr/bin',
    })
    expect(selected.sandbox).toBe('srt')
    expect(selected.profile?.filesystem.allowWithinDeny).toContain('/runs/isolates/42')
    expect(selected.profile?.filesystem.allowWrite).toEqual([
      '/runs/isolates/42',
      '/runs/sandbox-42',
      '/runs/42/scratch',
    ])
  })

  test('a host override records the lost isolate confinement only for no-repo runs', () => {
    const shared = {
      agent: 'grok',
      writesRepo: false,
      worktree: '/runs/isolates/42',
      runtimeDir: '/runs/sandbox-42',
      project: fixtureProject(),
      override: 'host',
      mcp: true,
    }
    const noRepo = selectReadonlySandbox({ ...shared, readsRepo: false })
    const repository = selectReadonlySandbox({ ...shared, readsRepo: true })

    expect(noRepo).toEqual({
      sandbox: 'host',
      profile: null,
      reason: 'BOTTEGA_SANDBOX=host skipped the no-repo isolate sandbox; run is unconfined',
    })
    expect(noRepo.reason).not.toBe(repository.reason)
    expect(repository).toEqual({
      sandbox: 'host',
      profile: null,
      reason: 'BOTTEGA_SANDBOX=host',
    })
  })

  test('a no-repo sandbox requires its root but not an own project', () => {
    expect(() =>
      selectReadonlySandbox({
        agent: 'grok',
        readsRepo: false,
        writesRepo: false,
        worktree: null,
        runtimeDir: '/runs/sandbox-42',
        project: fixtureProject(),
      }),
    ).toThrow('no-repo sandbox refusal: the sandbox root is missing')
    expect(
      selectReadonlySandbox({
        agent: 'grok',
        readsRepo: false,
        writesRepo: false,
        worktree: '/runs/isolates/42',
        runtimeDir: '/runs/sandbox-42',
        project: null,
        registeredProjects: [fixtureProject()],
      }).sandbox,
    ).toBe('srt')
  })

  test('codex and non-ACP writing jobs stay on the host seam', () => {
    for (const input of [
      { agent: 'codex', writesRepo: false },
      { agent: 'grok', writesRepo: true },
    ]) {
      expect(
        selectReadonlySandbox({
          ...input,
          readsRepo: true,
          worktree: '/runs/tree',
          runtimeDir: '/runs/evidence',
          project: fixtureProject(),
        }),
      ).toEqual({ sandbox: 'host', profile: null, reason: null })
    }
  })

  test('repository candidates keep their missing-root and missing-project host fallbacks', () => {
    for (const input of [
      { worktree: null, project: fixtureProject() },
      { worktree: '/runs/tree', project: null },
    ]) {
      expect(
        selectReadonlySandbox({
          agent: 'grok',
          readsRepo: true,
          writesRepo: false,
          runtimeDir: '/runs/evidence',
          ...input,
        }),
      ).toEqual({ sandbox: 'host', profile: null, reason: null })
    }
  })
})
