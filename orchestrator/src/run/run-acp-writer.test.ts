import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { isPathAtOrBelow } from '../artifact-paths.ts'
import { startAskHttpEndpoint } from '../ask/ask.ts'
import { runWorkerHomeDir } from '../run-owned-paths.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import {
  bindContract,
  checkpointContainment,
  disposeAskAfterStartup,
  runRoots,
} from './run-acp-writer.ts'

const tree: Worktree = {
  path: resolve('..'),
  branch: 'DEV-1530-test',
  base: 'base',
  repoRoot: resolve('..'),
}

test('writing ACP pure decisions expose only worker-owned writes and host checkpoint facts', () => {
  const runtimeDir = '/runs/sandbox-root'
  expect(runRoots(tree, true, true, '/run/scratch', runtimeDir)).toEqual([
    tree.path,
    '/run/scratch',
    '/runs/sandbox-root/harness',
  ])
  expect(checkpointContainment('/repo/.git/worktrees/run', true, runtimeDir)).toEqual({
    gitDir: '/repo/.git/worktrees/run',
    hooksDir: '/runs/sandbox-root/checkpoint-hooks',
    disableHooks: true,
  })
  expect(bindContract('contract', true)).toContain(
    'The orchestrator checkpoints and commits this run from the host.',
  )
  expect(bindContract('contract', true)).toContain('Do not run git commands that write.')
})

test('writing ACP grants exclude host hooks and the run-scoped worker home', () => {
  const runtimeDir = '/runs/sandbox-root'
  const grantedRoots = runRoots(tree, true, true, '/run/scratch', runtimeDir)
  const containment = checkpointContainment('/repo/.git/worktrees/run', true, runtimeDir)

  expect(containment.hooksDir).not.toBeNull()
  for (const grantedRoot of grantedRoots) {
    expect(isPathAtOrBelow(containment.hooksDir!, grantedRoot)).toBe(false)
    expect(isPathAtOrBelow(runWorkerHomeDir(runtimeDir), grantedRoot)).toBe(false)
  }
})

test('trusted writers keep their shared git roots and ordinary checkpoints', () => {
  expect(checkpointContainment(null, false, '/run/private')).toEqual({
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
