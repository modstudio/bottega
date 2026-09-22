import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { ROOT } from '../database/db.ts'
import { classify, NOT_EVIDENCE } from '../failure/failure.ts'
import type { Project } from '../project/projects.ts'
import {
  grokSandboxConfig,
  prepareGrokMcpHome,
  READONLY_LENS_DENY_PATHS,
  readonlyLensProfile,
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

test('prepares one persistent Grok MCP home and refuses a source clamp', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-grok-home-'))
  try {
    const source = join(fixture, 'source')
    const runDir = join(fixture, 'run')
    mkdirSync(source)
    writeFileSync(
      join(source, 'config.toml'),
      'model = "grok"\n[mcp_servers.orch]\ncommand = "orch"\n',
    )
    expect(prepareGrokMcpHome(runDir, ['stopal', 'alephbeis'], source)).toEqual({
      GROK_HOME: runDir,
      GROK_DISABLE_AUTOUPDATER: '1',
    })
    const written = readFileSync(join(runDir, 'config.toml'), 'utf8')
    expect(written.startsWith('disabled_mcp_servers = ["stopal","alephbeis"]\n\n')).toBe(true)
    expect(written).toContain('model = "grok"\n[mcp_servers.orch]')
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

describe('readonly-lens sandbox profile', () => {
  afterEach(resetSandbox)
  test('keeps the registered Grok stdio entry but points it at this checkout', () => {
    const config =
      '[mcp_servers.orch-ask]\ncommand = "bun"\nargs = ["/main/orchestrator/src/cli.ts", "ask-server"]\n'
    const rewritten = grokSandboxConfig(config)
    expect(rewritten).toContain(`command = ${JSON.stringify(Bun.which('bun') ?? process.execPath)}`)
    expect(rewritten).toContain('"ask-server"')
    expect(rewritten).not.toContain('/main/orchestrator/src/cli.ts')
    expect(rewritten).toContain('/orchestrator/src/ask/ask-proxy.ts')
  })
  test('builds allow and deny lists from the register fixture', () => {
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
      environment: {
        HOME: '/Users/operator',
        [CONFIG_HOME_ENV]: '/Users/operator/.config/platform',
        [HARNESS_ENV_FILE_ENV]: '',
      },
    })

    expect(profile.filesystem.denyRead).toEqual([
      ...READONLY_LENS_DENY_PATHS.map((path) => path.replace(/^~/, homedir())),
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

  test('a declared Docker allowance selects host with its register reason', () => {
    expect(
      selectReadonlySandbox({
        agent: 'grok',
        readsRepo: true,
        writesRepo: false,
        worktree: '/runs/tree',
        runsDir: '/runs/evidence',
        project: fixtureProject(),
        readonlyDocker: true,
      }),
    ).toEqual({
      sandbox: 'host',
      profile: null,
      reason: 'project worktree.readonly_docker allows read-only checks through Docker',
    })
  })

  test('an absent Docker allowance keeps srt and denies both system socket paths', () => {
    const selected = selectReadonlySandbox({
      agent: 'grok',
      readsRepo: true,
      writesRepo: false,
      worktree: '/runs/tree',
      runsDir: '/runs/evidence',
      project: fixtureProject(),
      path: '/usr/bin',
    })
    expect(selected.sandbox).toBe('srt')
    expect(selected.profile?.filesystem.denyRead).toEqual(
      expect.arrayContaining(['/var/run/docker.sock', '/run/docker.sock']),
    )
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
