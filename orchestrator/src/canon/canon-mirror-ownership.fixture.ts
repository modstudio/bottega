import { appendFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { setDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { type CanonMirrorPort, systemCanonMirrorPort } from './canon-mirror.ts'

export function mirrorRepository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
  spawnFixtureGitSync(['init', '-b', 'main'], { cwd: root })
  appendFileSync(
    join(root, '.git', 'config'),
    '\n[user]\n\temail = mirror@example.test\n\tname = Mirror Test\n',
  )
  spawnFixtureGitSync(['commit', '--allow-empty', '-m', 'fixture'], { cwd: root })
  return root
}

export async function registerManagedMirror(root: string, name: string): Promise<void> {
  installRecordApiClient(createMemoryRecordApiClient())
  upsertProject({
    recordId: newRecordId(),
    name,
    path: root,
    canon: true,
    settings: { managedContext: true, canonMirrorKey: 'DEV-1002', trunk: 'main' },
  })
  await setDoc({
    scope: 'canon',
    subject: name,
    slug: 'AGENTS.md',
    title: 'AGENTS.md',
    body: 'Managed context.\n',
    reason: 'mirror ownership fixture',
    allowCanonBootstrap: true,
  })
}

export function mirrorFixturePort(
  root: string,
  overrides: Partial<CanonMirrorPort> = {},
): CanonMirrorPort {
  const head = spawnFixtureGitSync(['rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim()
  return {
    ...systemCanonMirrorPort,
    fetch: () => {},
    localBranch: () => false,
    refTip: () => head,
    remoteBranchTip: () => null,
    remoteTrunkTip: () => head,
    push: () => {},
    pullRequest: () => null,
    openPullRequest: () => ({
      number: 7,
      url: 'https://example.test/pull/7',
      headSha: 'different-head',
      checks: 'passed',
    }),
    releaseRun: () => {
      const tree = join(root, '.claude', 'worktrees', 'canon-mirror')
      if (existsSync(join(tree, '.git')))
        spawnFixtureGitSync(['worktree', 'remove', '--force', tree], { cwd: root })
      return { outcome: 'released', detail: 'fixture release' }
    },
    releaseBranch: (_project, branch, expected) => {
      if (
        spawnFixtureGitSync(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
          cwd: root,
        }).exitCode === 0
      )
        spawnFixtureGitSync(['update-ref', '-d', `refs/heads/${branch}`, expected], { cwd: root })
    },
    ...overrides,
  }
}
