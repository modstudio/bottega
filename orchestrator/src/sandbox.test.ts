import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project } from './projects.ts'
import {
  grokSandboxConfig,
  READONLY_LENS_DENY_PATHS, readonlyLensProfile, readonlyNeedsDocker, selectReadonlySandbox,
  srtLaunchArgv,
} from './sandbox.ts'
import { classify, NOT_EVIDENCE } from './failure.ts'

const fixtureProject = (settings: Project['settings'] = {}): Project => ({
  id: 1,
  name: 'fixture',
  path: '/projects/fixture',
  stack: 'node',
  canon: true,
  settings,
})

describe('readonly-lens sandbox profile', () => {
  test('keeps the registered Grok stdio entry but points it at this checkout', () => {
    const config = '[mcp_servers.orch-ask]\ncommand = "bun"\nargs = ["/main/orchestrator/src/cli.ts", "ask-server"]\n'
    const rewritten = grokSandboxConfig(config)
    expect(rewritten).toContain('command = "bun"')
    expect(rewritten).toContain('"ask-server"')
    expect(rewritten).not.toContain('/main/orchestrator/src/cli.ts')
    expect(rewritten).toContain('/orchestrator/src/cli.ts')
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
    })

    expect(profile.filesystem.denyRead).toEqual([
      ...READONLY_LENS_DENY_PATHS.map((path) => path.replace(/^~/, homedir())),
      '/shared/absolute.secret',
      join(homedir(), '.tokens/private'),
      '/projects/fixture/config/operator.secret',
      '/var/run/docker.sock',
      '/run/docker.sock',
    ])
    expect(profile.filesystem.allowRead).toEqual([
      '/runs/tree', '/runs/evidence', '/opt/toolchain/bin', '/usr/bin',
      '/projects/fixture/node_modules', join(homedir(), '.claude.json'),
    ])
    expect(profile.filesystem.allowWrite).toEqual(['/runs/tree', '/runs/evidence'])
    expect(profile.network.allowedDomains).toEqual([
      'cli-chat-proxy.grok.com', 'auth.x.ai', 'api.x.ai',
      'localhost', '127.0.0.1', '[::1]',
    ])
    expect(profile.network.allowUnixSockets).toEqual([])
    expect(profile.network.allowLocalBinding).toBe(true)
  })

  test('a registered exact deny removes an otherwise allowed read', () => {
    const claudeConfig = join(homedir(), '.claude.json')
    const profile = readonlyLensProfile({
      worktree: '/runs/tree', runsDir: '/runs/evidence', agent: 'grok',
      project: fixtureProject({ secretPaths: [claudeConfig] }),
      path: '/usr/bin', nodeModuleLinks: [],
    })
    expect(profile.filesystem.denyRead).toContain(claudeConfig)
    expect(profile.filesystem.allowRead).not.toContain(claudeConfig)
  })

  test('a denied parent removes an allowed linked dependency child', () => {
    const profile = readonlyLensProfile({
      worktree: '/runs/tree', runsDir: '/runs/evidence', agent: 'grok',
      project: fixtureProject({ secretPaths: ['/projects/fixture/dependencies'] }),
      path: '/usr/bin', nodeModuleLinks: ['/projects/fixture/dependencies/node_modules'],
    })
    expect(profile.filesystem.allowRead).not.toContain('/projects/fixture/dependencies/node_modules')
  })

  test('a registered secret inside the worktree refuses the profile', () => {
    expect(() => readonlyLensProfile({
      worktree: '/runs/tree', runsDir: '/runs/evidence', agent: 'grok',
      project: fixtureProject({ secretPaths: ['/runs/tree/private/token'] }),
      path: '/usr/bin', nodeModuleLinks: [],
    })).toThrow('a registered secret path cannot be inside the worktree')
  })

  test('the srt argv helper owns settings persistence and wrapper grammar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-srt-profile-'))
    const path = join(dir, 'settings.json')
    const profile = readonlyLensProfile({
      worktree: '/runs/tree', runsDir: '/runs/evidence', agent: 'grok',
      project: fixtureProject(), path: '/usr/bin', nodeModuleLinks: [],
    })
    const argv = srtLaunchArgv(profile, path, 'grok', ['--flag'])
    expect(argv.slice(-3)).toEqual(['--', 'grok', '--flag'])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(profile)
    rmSync(dir, { recursive: true, force: true })
  })

  test('falls back to host when readonly notes need Docker', () => {
    expect(selectReadonlySandbox({
      agent: 'grok', readsRepo: true, writesRepo: false,
      worktree: '/runs/tree', runsDir: '/runs/evidence',
      project: fixtureProject(),
      readonlyNotes: 'Run the checks with docker compose exec app bun test.',
    })).toEqual({
      sandbox: 'host', profile: null,
      reason: 'project worktree.readonly_notes says read-only checks need Docker',
    })
  })

  test('a note merely saying Docker is unavailable does not disable confinement', () => {
    expect(readonlyNeedsDocker('Docker is unavailable in read-only worktrees; use bun tests.')).toBe(false)
  })

  test('codex and writing jobs stay on the host seam', () => {
    for (const input of [
      { agent: 'codex', writesRepo: false },
      { agent: 'grok', writesRepo: true },
    ]) {
      expect(selectReadonlySandbox({
        ...input, readsRepo: true, worktree: '/runs/tree', runsDir: '/runs/evidence',
        project: fixtureProject(),
      }).sandbox).toBe('host')
    }
  })

  test('sandbox denial classification is conditioned on srt and accepts every absolute path', () => {
    const hostDenial = 'cat: /Users/operator/.ssh/orch-sentinel: Operation not permitted'
    expect(classify(hostDenial, 1, false, 'host')).toBe('other')
    expect(classify('cat: /shared/x.secret: Operation not permitted', 1, false, 'srt'))
      .toBe('sandbox_denied')
    expect(classify('cat: /var/run/docker.sock: Operation not permitted', 1, false, 'srt'))
      .toBe('sandbox_denied')
    expect(NOT_EVIDENCE).toContain('sandbox_denied')
  })
})
