import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project } from './projects.ts'
import {
  grokSandboxConfig,
  READONLY_LENS_DENY_PATHS, readonlyLensProfile, readonlyNeedsDocker, selectReadonlySandbox,
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

  test('classifies an srt denied-read line with its path as not-evidence', () => {
    const denial = 'cat: /Users/operator/.ssh/orch-sentinel: Operation not permitted'
    expect(classify(denial)).toBe('sandbox_denied')
    expect(denial).toContain('/Users/operator/.ssh/orch-sentinel')
    expect(NOT_EVIDENCE).toContain('sandbox_denied')
  })
})
