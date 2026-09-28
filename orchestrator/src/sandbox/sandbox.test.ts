import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
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
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { hubLoginTokenDirectory, STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { workerHarnessName } from '../agent/worker-launch-env.ts'
import { ROOT } from '../database/db.ts'
import { classify, NOT_EVIDENCE } from '../failure/failure.ts'
import type { Project } from '../project/projects.ts'
import {
  grokSandboxConfig,
  prepareCodexHome,
  prepareGrokMcpHome,
  prepareSandboxHome,
  prepareWorkerHomeMirror,
  probeSandboxProfile,
  READONLY_LENS_DENY_PATHS,
  READONLY_LENS_DENY_SOCKETS,
  readonlyLensProfile,
  removeNewSandboxHomeAfterFailure,
  resetSandbox,
  sandboxRuntimeConfig,
  selectReadonlySandbox,
} from './sandbox.ts'

const fixtureProject = (settings: Project['settings'] = {}): Project => ({
  id: 1,
  name: 'fixture',
  path: '/projects/fixture',
  stack: 'node',
  canon: true,
  retiredAt: null,
  settings,
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

test('prepares one persistent Grok MCP home and refuses a source clamp', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-grok-home-'))
  try {
    const source = join(fixture, 'source')
    const runDir = join(fixture, 'run')
    mkdirSync(source)
    writeFileSync(
      join(source, 'config.toml'),
      'model = "grok"\n[mcp_servers.orch]\ncommand = "orch"\n' +
        '[mcp_servers.orch-ask]\ncommand = "/old/bun"\nargs = ["/main/orchestrator/src/cli.ts", "ask-server"]\n' +
        '[mcp_servers.orch-ask.env]\nSTALE = "1"\n',
    )
    expect(prepareGrokMcpHome(runDir, ['stopal', 'alephbeis'], source)).toEqual({
      GROK_HOME: runDir,
      GROK_DISABLE_AUTOUPDATER: '1',
    })
    const written = readFileSync(join(runDir, 'config.toml'), 'utf8')
    expect(written.startsWith('disabled_mcp_servers = ["stopal","alephbeis"]\n\n')).toBe(true)
    expect(written).toContain('model = "grok"\n[mcp_servers.orch]')
    expect(written).not.toContain('/main/orchestrator/src/cli.ts')
    expect(written).not.toContain('STALE')
    expect(written).toContain(`command = ${JSON.stringify(process.execPath)}`)
    expect(written).toContain(JSON.stringify(join(ROOT, 'src', 'cli', 'orch.ts')))
    writeFileSync(join(source, 'config.toml'), 'replacement = true\n')
    prepareGrokMcpHome(runDir, [], source)
    expect(readFileSync(join(runDir, 'config.toml'), 'utf8')).toBe(written)
    const conflict = join(fixture, 'conflict')
    mkdirSync(conflict)
    writeFileSync(
      join(conflict, 'config.toml'),
      'disabled_mcp_servers = ["x"]\n[mcp_servers.orch]\n',
    )
    expect(() => prepareGrokMcpHome(join(fixture, 'conflict-run'), [], conflict)).toThrow(
      `disabled_mcp_servers is already declared in ${join(conflict, 'config.toml')}`,
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('prepares one persistent Codex home per chain without operator canon or sessions', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-codex-home-'))
  try {
    const source = join(fixture, 'operator-codex')
    const runDir = join(fixture, 'sandbox-41')
    mkdirSync(join(source, 'rules'), { recursive: true })
    mkdirSync(join(source, 'sessions'))
    writeFileSync(join(source, 'auth.json'), '{}')
    const config = 'model = """\nfixture\nproject_doc_max_bytes = 4096\n"""\n'
    writeFileSync(join(source, 'config.toml'), config)
    writeFileSync(join(source, 'AGENTS.md'), 'Operator canon.')
    writeFileSync(join(source, 'rules', 'default.rules'), 'allow')

    const first = prepareCodexHome(runDir, { HOME: fixture, CODEX_HOME: source })
    expect(first).toEqual({ CODEX_HOME: join(runDir, 'codex') })
    expect(lstatSync(join(first.CODEX_HOME!, 'auth.json')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(first.CODEX_HOME!, 'auth.json'))).toBe(join(source, 'auth.json'))
    expect(readFileSync(join(first.CODEX_HOME!, 'config.toml'), 'utf8')).toBe(config)
    expect(statSync(runDir).mode & 0o777).toBe(0o700)
    expect(statSync(first.CODEX_HOME!).mode & 0o777).toBe(0o700)
    expect(statSync(join(first.CODEX_HOME!, 'config.toml')).mode & 0o777).toBe(0o600)
    for (const omitted of ['AGENTS.md', 'AGENTS.override.md', 'rules', 'sessions']) {
      expect(existsSync(join(first.CODEX_HOME!, omitted))).toBe(false)
    }

    writeFileSync(join(source, 'config.toml'), 'model = "changed-after-first-turn"\n')
    chmodSync(runDir, 0o755)
    chmodSync(first.CODEX_HOME!, 0o755)
    const resumed = prepareSandboxHome('codex', runDir, { HOME: fixture, CODEX_HOME: source })
    expect(resumed).toEqual(first)
    expect(readFileSync(join(resumed.CODEX_HOME!, 'config.toml'), 'utf8')).toBe(config)
    expect(statSync(runDir).mode & 0o777).toBe(0o700)
    expect(statSync(resumed.CODEX_HOME!).mode & 0o777).toBe(0o700)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('Codex home refuses a missing credential with a login remedy', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-codex-auth-'))
  try {
    expect(() => prepareCodexHome(join(fixture, 'run'), { HOME: fixture })).toThrow(
      `Codex worker home refusal: ${join(fixture, '.codex', 'auth.json')} is absent; run codex login for that home and retry`,
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('Codex home refuses a symlinked config without changing its target', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-codex-config-symlink-'))
  try {
    const source = join(fixture, 'operator-codex')
    const runDir = join(fixture, 'run')
    const target = join(fixture, 'outside.toml')
    mkdirSync(source)
    mkdirSync(join(runDir, 'codex'), { recursive: true })
    writeFileSync(join(source, 'auth.json'), '{}')
    writeFileSync(join(source, 'config.toml'), 'model = "operator"\n')
    writeFileSync(target, 'must stay unchanged\n')
    symlinkSync(target, join(runDir, 'codex', 'config.toml'))

    expect(() => prepareCodexHome(runDir, { CODEX_HOME: source })).toThrow(
      `Codex worker home refusal: ${join(runDir, 'codex', 'config.toml')} is not a regular non-symlink file owned by this user; remove the run's Codex home and retry`,
    )
    expect(readFileSync(target, 'utf8')).toBe('must stay unchanged\n')
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
    )
    const grok = prepareSandboxHome(
      workerHarnessName({ name: 'registered-grok', harness: 'grok' }),
      join(fixture, 'grok-run'),
      environment,
    )
    expect(codex.CODEX_HOME).toBe(join(fixture, 'codex-run', 'codex'))
    expect(grok.GROK_HOME).toBe(join(fixture, 'grok-run'))
    expect(grok.HOME).toBe(join(fixture, 'grok-run', 'home'))
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
      prepareGrokMcpHome(failedSetup, [], grokSource)
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

test('probe sandbox profile denies network and writes except the throwaway directory', () => {
  const scratch = '/tmp/orch-probe-scratch'
  const profile = probeSandboxProfile({
    allowWriteDir: scratch,
    cwd: '/projects/fixture',
    project: fixtureProject(),
  })
  expect(profile.network.allowedDomains).toEqual([])
  expect(profile.network.allowUnixSockets).toEqual([])
  expect(profile.network.allowLocalBinding).toBe(false)
  expect(profile.filesystem.allowWrite).toEqual([resolve(scratch)])
  expect(profile.filesystem.denyRead).toEqual(
    expect.arrayContaining([
      ...READONLY_LENS_DENY_PATHS.map((path) => path.replace(/^~/, homedir())),
      ...READONLY_LENS_DENY_SOCKETS,
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
  test('replaces a stale registered Grok orch-ask entry with this checkout proxy', () => {
    const config =
      '[mcp_servers.orch-ask]\ncommand = "bun"\nargs = ["/main/orchestrator/src/cli.ts", "ask-server"]\n'
    const rewritten = grokSandboxConfig(config)
    expect(rewritten).toContain(`command = ${JSON.stringify(Bun.which('bun') ?? process.execPath)}`)
    expect(rewritten).toContain('"ask-server"')
    expect(rewritten).not.toContain('/main/orchestrator/src/cli.ts')
    expect(rewritten).toContain('/orchestrator/src/ask/ask-proxy.ts')
  })
  test('keeps every other table, array tables included, around the replaced orch-ask', () => {
    const config =
      '[cli]\na = 1\n[marketplace]\nb = 2\n[[marketplace.sources]]\nurl = "before"\n' +
      '[mcp_servers.orch-ask]\ncommand = "x"\n[mcp_servers.orch-ask.env]\nK = "v"\n' +
      '[[marketplace.sources]]\nurl = "after"\n[ui]\nc = 3\n'
    const rewritten = grokSandboxConfig(config)
    for (const kept of ['[cli]', '[marketplace]', 'url = "before"', 'url = "after"', '[ui]']) {
      expect(rewritten).toContain(kept)
    }
    expect(rewritten.match(/\[\[marketplace\.sources\]\]/g)?.length).toBe(2)
    expect(rewritten).not.toContain('command = "x"')
    expect(rewritten).not.toContain('K = "v"')
  })
  test('adds a live orch-ask table when the user config has none', () => {
    const rewritten = grokSandboxConfig('model = "grok"\n')
    expect(rewritten).toContain('model = "grok"')
    expect(rewritten).toContain('[mcp_servers.orch-ask]')
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
      runsDir: '/runs/evidence',
      project,
      agent: 'grok',
      path: '/opt/toolchain/bin:/usr/bin',
      nodeModuleLinks: ['/projects/fixture/node_modules'],
      environment,
    })

    expect(profile.filesystem.denyRead).toEqual([
      ...READONLY_LENS_DENY_PATHS.map((path) => path.replace(/^~/, homedir())),
      hubLoginTokenDirectory(environment),
      join('/Users/operator/.config/platform', `${PLATFORM_SLUG}.env`),
      '/shared/absolute.secret',
      join(homedir(), '.tokens/private'),
      '/projects/fixture/config/operator.secret',
      '/var/run/docker.sock',
      '/run/docker.sock',
    ])
    expect(profile.filesystem.allowWithinDeny).toEqual([
      '/runs/tree',
      '/runs/evidence',
      '/opt/toolchain/bin',
      '/usr/bin',
      '/projects/fixture/node_modules',
      join(homedir(), '.claude.json'),
      process.execPath,
      ROOT,
    ])
    expect(profile.filesystem.allowWrite).toEqual(['/runs/tree', '/runs/evidence'])
    expect(profile.filesystem.allowWrite).not.toContain(hubLoginTokenDirectory(environment))
    expect(profile.network.allowedDomains).toEqual([
      'cli-chat-proxy.grok.com',
      'auth.x.ai',
      'api.x.ai',
      'localhost',
      '127.0.0.1',
      '[::1]',
    ])
    expect(profile.network.allowUnixSockets).toEqual([])
    expect(profile.network.allowLocalBinding).toBe(true)
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
      runsDir: '/runs/evidence',
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
      runsDir: '/runs/evidence',
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
      runsDir: '/runs/evidence',
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
        runsDir: '/runs/evidence',
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
        runsDir: '/runs/evidence',
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
      runsDir: '/runs/evidence',
      agent: 'grok',
      project: fixtureProject(),
      path: '/usr/bin',
      nodeModuleLinks: [],
    })
    profile.network.allowUnixSockets.push('/runs/evidence/grok-leader.sock')
    expect(sandboxRuntimeConfig(profile)).toEqual({
      ...profile,
      filesystem: {
        denyRead: profile.filesystem.denyRead,
        allowRead: profile.filesystem.allowWithinDeny,
        allowWrite: profile.filesystem.allowWrite,
        denyWrite: profile.filesystem.denyWrite,
      },
    })
  })

  test('readonly_docker=true removes only socket denies (mutation: invert allowDockerSocket branch)', () => {
    const selected = selectReadonlySandbox({
      agent: 'grok',
      readsRepo: true,
      writesRepo: false,
      worktree: '/runs/tree',
      runsDir: '/runs/evidence',
      project: fixtureProject(),
      readonlyDocker: true,
      path: '/usr/bin',
      environment: {
        HOME: homedir(),
        [STATE_HOME_ENV]: temporaryState(),
        [CONFIG_HOME_ENV]: '/Users/operator/.config/platform',
        [HARNESS_ENV_FILE_ENV]: '',
        DOCKER_HOST: '',
      },
    })

    expect(selected.sandbox).toBe('srt')
    expect(selected.reason).toBe(
      'project worktree.readonly_docker allows the Docker socket; every other read-only confinement holds',
    )
    expect(selected.profile?.filesystem.denyRead).toEqual(
      expect.arrayContaining(READONLY_LENS_DENY_PATHS.map((path) => path.replace(/^~/, homedir()))),
    )
    for (const socket of READONLY_LENS_DENY_SOCKETS) {
      expect(selected.profile?.filesystem.denyRead).not.toContain(socket)
    }
    expect(selected.profile?.network.allowUnixSockets).toEqual([
      ...READONLY_LENS_DENY_SOCKETS,
      join(homedir(), '.docker/run/docker.sock'),
    ])
  })

  test('readonly_docker=false keeps both socket denies (mutation: invert allowDockerSocket branch)', () => {
    const selected = selectReadonlySandbox({
      agent: 'grok',
      readsRepo: true,
      writesRepo: false,
      worktree: '/runs/tree',
      runsDir: '/runs/evidence',
      project: fixtureProject(),
      path: '/usr/bin',
      environment: {
        HOME: homedir(),
        [STATE_HOME_ENV]: temporaryState(),
        [CONFIG_HOME_ENV]: '/Users/operator/.config/platform',
        [HARNESS_ENV_FILE_ENV]: '',
        DOCKER_HOST: '',
      },
    })
    expect(selected.sandbox).toBe('srt')
    expect(selected.profile?.filesystem.denyRead).toEqual(
      expect.arrayContaining([...READONLY_LENS_DENY_SOCKETS]),
    )
    expect(selected.profile?.network.allowUnixSockets).toEqual([])
  })

  test('a flagged profile uses a unix DOCKER_HOST instead of the standard socket paths', () => {
    const profile = readonlyLensProfile({
      worktree: '/runs/tree',
      runsDir: '/runs/evidence',
      project: fixtureProject(),
      agent: 'grok',
      path: '/usr/bin',
      nodeModuleLinks: [],
      allowDockerSocket: true,
      environment: {
        HOME: homedir(),
        [STATE_HOME_ENV]: temporaryState(),
        [CONFIG_HOME_ENV]: '/Users/operator/.config/platform',
        [HARNESS_ENV_FILE_ENV]: '',
        DOCKER_HOST: 'unix:///custom/docker.sock',
      },
    })

    expect(profile.network.allowUnixSockets).toEqual(['/custom/docker.sock'])
  })

  test('an MCP Grok repository run is unconfined because srt blocks its transports', () => {
    expect(
      selectReadonlySandbox({
        agent: 'grok',
        readsRepo: true,
        writesRepo: false,
        mcp: true,
        worktree: '/runs/tree',
        runsDir: '/runs/evidence',
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
        runsDir: '/runs/evidence',
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
      runsDir: '/runs/sandbox-42',
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
      runsDir: '/runs/sandbox-42',
      project: fixtureProject(),
      override: 'host',
      mcp: true,
    }
    const noRepo = selectReadonlySandbox({ ...shared, readsRepo: false })
    const repository = selectReadonlySandbox({ ...shared, readsRepo: true })

    expect(noRepo).toEqual({
      sandbox: 'host',
      profile: null,
      reason: 'ORCH_SANDBOX=host skipped the no-repo isolate sandbox; run is unconfined',
    })
    expect(noRepo.reason).not.toBe(repository.reason)
    expect(repository).toEqual({
      sandbox: 'host',
      profile: null,
      reason: 'ORCH_SANDBOX=host',
    })
  })

  test('a no-repo sandbox requires its root but not a registered project', () => {
    expect(() =>
      selectReadonlySandbox({
        agent: 'grok',
        readsRepo: false,
        writesRepo: false,
        worktree: null,
        runsDir: '/runs/sandbox-42',
        project: fixtureProject(),
      }),
    ).toThrow('no-repo sandbox refusal: the sandbox root is missing')
    expect(
      selectReadonlySandbox({
        agent: 'grok',
        readsRepo: false,
        writesRepo: false,
        worktree: '/runs/isolates/42',
        runsDir: '/runs/sandbox-42',
        project: null,
      }).sandbox,
    ).toBe('srt')
  })

  test('codex and writing jobs stay on the host seam', () => {
    for (const input of [
      { agent: 'codex', writesRepo: false },
      { agent: 'grok', writesRepo: true },
    ]) {
      expect(
        selectReadonlySandbox({
          ...input,
          readsRepo: true,
          worktree: '/runs/tree',
          runsDir: '/runs/evidence',
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
          runsDir: '/runs/evidence',
          ...input,
        }),
      ).toEqual({ sandbox: 'host', profile: null, reason: null })
    }
  })

  test('sandbox denial classification is conditioned on srt and accepts every absolute path', () => {
    const hostDenial = 'cat: /Users/operator/.ssh/orch-sentinel: Operation not permitted'
    expect(classify(hostDenial, 1, false, 'host')).toBe('other')
    expect(classify('cat: /shared/x.secret: Operation not permitted', 1, false, 'srt')).toBe(
      'sandbox_denied',
    )
    expect(classify('cat: /var/run/docker.sock: Operation not permitted', 1, false, 'srt')).toBe(
      'sandbox_denied',
    )
    expect(NOT_EVIDENCE).toContain('sandbox_denied')
  })
})
