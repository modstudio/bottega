import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { OrphanProcess, ProcessFact } from '../resources/process-inventory.ts'
import {
  automaticOrphanReclaimDecision,
  orphanProcessReverification,
  orphanSignalPlan,
} from './orphan-process-reclaim.ts'

const identity = { pid: 42, startTime: 'start', command: 'vite', missingTree: '/trees/gone' }

test('orphan process reclamation requires unchanged birth, command, and missing tree', () => {
  expect(orphanProcessReverification(identity, identity)).toEqual({ safe: true })
  expect(orphanProcessReverification(identity, { ...identity, command: 'other' })).toEqual({
    safe: false,
    reason: 'pid 42 command changed from vite to other',
  })
  expect(orphanProcessReverification(identity, { ...identity, startTime: 'later' }).safe).toBe(
    false,
  )
  expect(
    orphanProcessReverification(identity, { ...identity, missingTree: '/trees/other' }).safe,
  ).toBe(false)
  expect(orphanProcessReverification(identity, null).safe).toBe(false)
})

const orphan = (overrides: Partial<OrphanProcess> = {}): OrphanProcess => ({
  pid: 42,
  ppid: 1,
  pgid: 42,
  command: 'vite',
  ageSeconds: 120,
  startTime: 'start',
  cwd: '/trees/gone',
  missingTree: '/trees/gone',
  project: 'app',
  match: 'cwd',
  ...overrides,
})

test('automatic reclaim requires cwd evidence, age, non-platform command, and no live run', () => {
  expect(automaticOrphanReclaimDecision(orphan(), new Set())).toEqual({ reclaim: true })
  expect(automaticOrphanReclaimDecision(orphan({ match: 'argument' }), new Set()).reclaim).toBe(
    false,
  )
  expect(
    automaticOrphanReclaimDecision(orphan({ command: `${PLATFORM_SLUG} recipe undo` }), new Set())
      .reclaim,
  ).toBe(false)
  expect(automaticOrphanReclaimDecision(orphan({ ageSeconds: 1 }), new Set()).reclaim).toBe(false)
  expect(automaticOrphanReclaimDecision(orphan(), new Set(['/trees/gone'])).reclaim).toBe(false)
})

test('signals a group only when every member is a same-tree orphan or descendant', () => {
  const root = orphan()
  const child: ProcessFact = { ...root, pid: 43, ppid: 42, cwd: null }
  expect(orphanSignalPlan(root, [root, child], [root], 99)).toEqual({ kind: 'group', pgid: 42 })
  const unrelated: ProcessFact = { ...root, pid: 44, ppid: 1, cwd: null }
  expect(orphanSignalPlan(root, [root, child, unrelated], [root], 99)).toEqual({
    kind: 'pids',
    pids: [43, 42],
  })
  expect(orphanSignalPlan(root, [root, child], [root], 42)).toEqual({
    kind: 'pids',
    pids: [43, 42],
  })
})
