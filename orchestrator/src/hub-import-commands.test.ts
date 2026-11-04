import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../shared/embedded-assets.ts'
import { hubImportJudgeCommand, registeredHubCheckout } from './hub-import-commands.ts'

afterEach(() => registerEmbeddedAssets(null))

describe('hub import judge applicability', () => {
  test('returns ok in a distribution when the file is outside a registered checkout', async () => {
    registerEmbeddedAssets({
      assets: {},
      files: {},
      manifest: {
        name: PLATFORM_NAME,
        version: '1.2.3',
        built: '2026-11-03T00:00:00.000Z',
        commit: 'abcdef',
      },
    })
    const database = new Database(':memory:')
    database.run(
      'CREATE TABLE project (record_id TEXT PRIMARY KEY, name TEXT, path TEXT, stack TEXT, canon INTEGER, settings TEXT, retired_at TEXT)',
    )
    const result = await hubImportJudgeCommand(
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/tmp/hub/example.ts' } }),
      Date.now() + 1_000,
      () => database,
    )
    expect(result).toEqual({ status: 'ok', findings: [] })
  })

  test('returns unchecked in a distribution for a file inside a registered checkout', async () => {
    registerEmbeddedAssets({
      assets: {},
      files: {},
      manifest: {
        name: PLATFORM_NAME,
        version: '1.2.3',
        built: '2026-11-03T00:00:00.000Z',
        commit: 'abcdef',
      },
    })
    const projectPath = resolve(import.meta.dir, '../..')
    const file = join(projectPath, 'hub', 'example.ts')
    const database = new Database(':memory:')
    database.run(
      'CREATE TABLE project (record_id TEXT PRIMARY KEY, name TEXT, path TEXT, stack TEXT, canon INTEGER, settings TEXT, retired_at TEXT)',
    )
    database.run(
      'INSERT INTO project (record_id, name, path, stack, canon, settings, retired_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      ['project', PLATFORM_SLUG, projectPath, 'bun', 1, '{}'],
    )
    const result = await hubImportJudgeCommand(
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }),
      Date.now() + 1_000,
      () => database,
    )
    expect(result).toEqual({
      status: 'unchecked',
      findings: [],
      reason: 'hub import judging requires the policy scripts from a development checkout',
    })
  })
  test('does not judge a matching path outside the registered checkout', () => {
    const project = { name: PLATFORM_SLUG, path: '/registered/workshop' }
    expect(registeredHubCheckout('/scratch/other/hub/ui/example.ts', project)).toBeNull()
  })

  test('rejects symlink escapes and judges a sibling registered worktree', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'hub-import-applicability-'))
    const projectPath = join(scratch, 'workshop')
    const worktree = join(projectPath, '.claude/worktrees/orch-sibling')
    const outside = join(scratch, 'outside')
    mkdirSync(join(projectPath, 'hub/web/src/components'), { recursive: true })
    mkdirSync(join(worktree, 'hub/web/src/components'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'leak.ts'), 'export const marker = true\n')
    symlinkSync(join(outside, 'leak.ts'), join(projectPath, 'hub/web/src/components/leak.ts'))
    symlinkSync(outside, join(projectPath, 'hub/web/src/components/linked-parent'))
    const project = { name: PLATFORM_SLUG, path: projectPath }
    try {
      expect(
        registeredHubCheckout(join(projectPath, 'hub/web/src/components/leak.ts'), project),
      ).toBeNull()
      expect(
        registeredHubCheckout(
          join(projectPath, 'hub/web/src/components/linked-parent/probe.ts'),
          project,
        ),
      ).toBeNull()
      expect(
        registeredHubCheckout(join(worktree, 'hub/web/src/components/probe.ts'), project),
      ).toEqual({
        checkout: realpathSync(worktree),
        file: join(realpathSync(worktree), 'hub/web/src/components/probe.ts'),
      })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
