import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { OrphanProcess, ProcessFact } from '../resources/process-inventory.ts'
import {
  automaticOrphanReclaimDecision,
  orphanProcessReverification,
  orphanSignalPlan,
  signalFreshOrphanPlan,
} from './orphan-process-reclaim.ts'

const identity = {
  pid: 42,
  startTime: 'start',
  command: 'vite',
  missingTree: '/trees/gone',
  match: 'cwd' as const,
  cwdVerified: true,
}

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
  expect(orphanProcessReverification(identity, { ...identity, cwdVerified: false })).toEqual({
    safe: false,
    reason: 'pid 42 cwd process birth could not be verified',
  })
})

const orphan = (overrides: Partial<OrphanProcess> = {}): OrphanProcess => ({
  pid: 42,
  ppid: 1,
  pgid: 42,
  cpu: 0,
  command: 'vite',
  ageSeconds: 120,
  startTime: 'start',
  cwd: '/trees/gone',
  cwdVerified: true,
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
  expect(automaticOrphanReclaimDecision(orphan({ ageSeconds: 1 }), new Set(), true)).toEqual({
    reclaim: true,
  })
  expect(automaticOrphanReclaimDecision(orphan(), new Set(['/trees/gone'])).reclaim).toBe(false)
  expect(automaticOrphanReclaimDecision(orphan({ cwdVerified: false }), new Set())).toEqual({
    reclaim: false,
    reason: 'cwd process birth could not be verified',
  })
})

test('a signal plan contains only the root and descendants with their births', () => {
  const root = orphan()
  const child: ProcessFact = { ...root, pid: 43, ppid: 42, cwd: null }
  const unrelated: ProcessFact = { ...root, pid: 44, ppid: 1, cwd: null }
  expect(
    orphanSignalPlan(
      root,
      [root, child, unrelated],
      new Map([
        [42, 'root-birth'],
        [43, 'child-birth'],
        [44, 'other-birth'],
      ]),
    ),
  ).toEqual({
    targets: [
      { pid: 43, startTime: 'child-birth' },
      { pid: 42, startTime: 'root-birth' },
    ],
  })
})

test('a signal pass uses a fresh plan and skips a descendant whose birth changed', () => {
  const signaled: number[] = []
  const freshPlan = {
    targets: [
      { pid: 43, startTime: 'child-birth' },
      { pid: 42, startTime: 'root-birth' },
    ],
  }
  expect(
    signalFreshOrphanPlan(orphan(), 'SIGTERM', {
      freshPlan: () => ({ ok: true, plan: freshPlan }),
      identity: (pid, birth) => (pid === 42 && birth === 'root-birth' ? 'live' : 'reused'),
      kill: ((pid: number) => {
        signaled.push(pid)
        return true
      }) as typeof process.kill,
    }),
  ).toEqual({ ok: true })
  expect(signaled).toEqual([42])
})

test('a denied orphan signal is a refusal with the owning-user remedy', () => {
  expect(
    signalFreshOrphanPlan(orphan(), 'SIGTERM', {
      freshPlan: () => ({
        ok: true,
        plan: { targets: [{ pid: 42, startTime: 'root-birth' }] },
      }),
      identity: () => 'live',
      kill: (() => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      }) as typeof process.kill,
    }),
  ).toEqual({
    ok: false,
    reason: 'pid 42 exists but this user may not signal it; rerun as the owning user',
  })
})
