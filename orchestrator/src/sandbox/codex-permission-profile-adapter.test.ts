import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexPermissionLaunchProfileInput } from './codex-permission-profile-adapter.ts'

test('a continued turn rebuilds its profile and denies an entry created after the first launch', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-profile-turn-'))
  try {
    const own = join(root, 'projects', 'proj', 'worktrees', 'own')
    const firstSibling = join(root, 'projects', 'proj', 'worktrees', 'first-sibling')
    mkdirSync(own, { recursive: true })
    mkdirSync(firstSibling)
    const profile = {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowUnixSockets: [],
        allowLocalBinding: false,
      },
      filesystem: {
        denyRead: [join(root, 'projects')],
        allowWithinDeny: [own],
        allowWrite: [own],
        denyWrite: [],
      },
    }
    const launch = () =>
      codexPermissionLaunchProfileInput({
        profile,
        sandbox: 'workspace-write',
        cwd: own,
        writableRoots: [],
        tempDir: undefined,
        writesRepository: false,
      })

    expect(launch().filesystem.denyRead).toContain(firstSibling)
    const laterSibling = join(root, 'projects', 'proj', 'worktrees', 'later-sibling')
    mkdirSync(laterSibling)
    writeFileSync(join(laterSibling, 'secret'), 'fixture')
    expect(launch().filesystem.denyRead).toContain(laterSibling)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
