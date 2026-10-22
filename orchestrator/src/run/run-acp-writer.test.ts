import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { startAskHttpEndpoint } from '../ask/ask.ts'
import { worktreeGitDir } from '../git/git-environment.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import {
  bindContract,
  checkpointContainment,
  disposeAskAfterStartup,
  writableRoots,
} from './run-acp-writer.ts'

const tree: Worktree = {
  path: resolve('..'),
  branch: 'DEV-1530-test',
  base: 'base',
  repoRoot: resolve('..'),
}

test('writing ACP pure decisions expose only worker-owned writes and host checkpoint facts', () => {
  expect(writableRoots(tree, true, true, '/run/scratch')).toEqual([tree.path, '/run/scratch'])
  expect(checkpointContainment(tree, true, '/run/private')).toEqual({
    gitDir: worktreeGitDir(tree.path),
    hooksDir: '/run/private/checkpoint-hooks',
    disableHooks: true,
  })
  expect(bindContract('contract', true)).toContain(
    'The orchestrator checkpoints and commits this run from the host.',
  )
  expect(bindContract('contract', true)).toContain('Do not run git commands that write.')
})

test('trusted writers keep their shared git roots and ordinary checkpoints', () => {
  expect(checkpointContainment(tree, false, '/run/private')).toEqual({
    gitDir: null,
    hooksDir: null,
    disableHooks: false,
  })
})

test('a startup failure after creating the writing ACP ask endpoint closes its listener', async () => {
  const endpoint = startAskHttpEndpoint('missing-run', 'token')
  expect((await fetch(endpoint.url)).status).toBe(401)

  await disposeAskAfterStartup(endpoint, false)

  await expect(fetch(endpoint.url)).rejects.toThrow()
})
