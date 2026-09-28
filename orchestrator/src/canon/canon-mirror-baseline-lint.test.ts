import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { setDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { mirrorRepositoryCanon, systemCanonMirrorPort } from './canon-mirror.ts'

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'canon-mirror-baseline-lint-'))
  spawnFixtureGitSync(['init'], { cwd: root })
  writeFileSync(join(root, 'README.txt'), 'fixture\n')
  writeFileSync(join(root, 'AGENTS.md'), 'Keep 123 rules.\n\nOld managed context.\n')
  spawnFixtureGitSync(['add', '.'], { cwd: root })
  spawnFixtureGitSync(
    [
      '-c',
      'user.email=mirror@example.test',
      '-c',
      'user.name=Mirror Test',
      'commit',
      '-m',
      'fixture',
    ],
    { cwd: root },
  )
  return root
}

test('a pre-existing canon lint finding does not stop publication', async () => {
  const root = repository()
  const head = spawnFixtureGitSync(['rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim()
  let pushed = false
  try {
    installRecordApiClient(createMemoryRecordApiClient())
    upsertProject({
      name: 'canon-mirror-baseline-lint',
      path: root,
      canon: true,
      settings: { managedContext: true, canonMirrorKey: 'DEV-1002', trunk: 'main' },
    })
    await setDoc({
      scope: 'canon',
      subject: 'canon-mirror-baseline-lint',
      slug: 'AGENTS.md',
      title: 'AGENTS.md',
      body: 'Keep 123 rules.\n\nNew managed context.\n',
      reason: 'change context while preserving baseline lint finding',
      allowCanonBootstrap: true,
    })
    const results = await mirrorRepositoryCanon({
      project: 'canon-mirror-baseline-lint',
      dryRun: false,
      port: {
        ...systemCanonMirrorPort,
        fetch: () => {},
        localBranch: () => false,
        refTip: () => head,
        remoteBranchTip: () => null,
        remoteTrunkTip: () => head,
        push: () => {
          pushed = true
        },
        pullRequest: () => null,
        openPullRequest: () => ({
          number: 1,
          url: 'https://example.test/pull/1',
          headSha: 'different-head',
          checks: 'passed',
        }),
        releaseBranch: () => {},
        releaseRun: () => ({ outcome: 'released', detail: 'fixture release' }),
      },
      noteFailure: async () => {},
    })
    expect(results[0]).toMatchObject({ failed: false, text: expect.stringContaining('PR opened') })
    expect(pushed).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
