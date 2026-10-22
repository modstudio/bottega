import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { startAskHttpEndpoint } from '../ask/ask.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import {
  bindContract,
  checkpointContainment,
  confinementRoots,
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
  expect(checkpointContainment('/repo/.git/worktrees/run', true, '/run/private')).toEqual({
    gitDir: '/repo/.git/worktrees/run',
    hooksDir: '/run/private/checkpoint-hooks',
    disableHooks: true,
  })
  expect(bindContract('contract', true)).toContain(
    'The orchestrator checkpoints and commits this run from the host.',
  )
  expect(bindContract('contract', true)).toContain('Do not run git commands that write.')
})

test('trusted writers keep their shared git roots and ordinary checkpoints', () => {
  expect(checkpointContainment(null, false, '/run/private')).toEqual({
    gitDir: null,
    hooksDir: null,
    disableHooks: false,
  })
})

test('recorded confinement exposes sandbox roots and leaves host workers unproved', () => {
  expect(
    confinementRoots({ filesystem: { allowWrite: ['/run/tree'] } }, 'grok', '/run/tree', []),
  ).toEqual(['/run/tree'])
  expect(confinementRoots(null, 'grok', '/run/tree', [])).toBeNull()
  expect(confinementRoots(null, 'codex', '/run/tree', ['/run/scratch'])).toContain('/run/tree')
})

test('a startup failure after creating the writing ACP ask endpoint closes its listener', async () => {
  const endpoint = startAskHttpEndpoint('missing-run', 'token')
  expect((await fetch(endpoint.url)).status).toBe(401)

  await disposeAskAfterStartup(endpoint, false)

  await expect(fetch(endpoint.url)).rejects.toThrow()
})
