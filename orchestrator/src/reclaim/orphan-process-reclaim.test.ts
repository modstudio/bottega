import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { OrphanProcess, ProcessFact } from '../resources/process-inventory.ts'
import {
  applyRunProcessGroupEvidence,
  automaticOrphanReclaimDecision,
  type OwnedOrphanProcess,
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

const orphanRow = (overrides: Partial<OrphanProcess> = {}): OrphanProcess => ({
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
  runMarker: 'present',
  ...overrides,
})

/**
 * A decision input, i.e. a row the ownership fold has branded. Production folds
 * the recorded run process groups in through `orphansWithOwnershipEvidence`;
 * here the fold adds none, so the row carries only what the test set.
 */
const orphan = (overrides: Partial<OrphanProcess> = {}): OwnedOrphanProcess =>
  applyRunProcessGroupEvidence([orphanRow(overrides)], [])[0]!

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

test('automatic reclaim requires positive evidence that a run started the process', () => {
  expect(automaticOrphanReclaimDecision(orphan({ runMarker: 'present' }), new Set())).toEqual({
    reclaim: true,
  })
  expect(automaticOrphanReclaimDecision(orphan({ runMarker: 'absent' }), new Set())).toEqual({
    reclaim: false,
    reason:
      'process carries neither the run delegation marker nor the run-process marker; reclaim it manually if it is residue',
  })
  expect(automaticOrphanReclaimDecision(orphan({ runMarker: 'unknown' }), new Set())).toEqual({
    reclaim: false,
    reason: 'process environment could not be read to prove a run started it',
  })
})

test('a candidate in a recorded run process group is run residue whatever its environment says', () => {
  const runs = [{ worktree: '/trees/gone', agentPgid: 42 }]
  expect(applyRunProcessGroupEvidence([orphan({ runMarker: 'absent' })], runs)).toEqual([
    { ...orphan(), runMarker: 'present' },
  ])
  expect(applyRunProcessGroupEvidence([orphan({ runMarker: 'unknown' })], runs)[0]!.runMarker).toBe(
    'present',
  )
  // A recorded group belongs to one tree: the same group elsewhere proves nothing.
  expect(
    applyRunProcessGroupEvidence(
      [orphan({ runMarker: 'absent' })],
      [{ worktree: '/trees/other', agentPgid: 42 }],
    )[0]!.runMarker,
  ).toBe('absent')
  // Neither does the tree alone, or a candidate leading its own group.
  expect(
    applyRunProcessGroupEvidence([orphan({ runMarker: 'absent', pgid: 7 })], runs)[0]!.runMarker,
  ).toBe('absent')
  expect(
    applyRunProcessGroupEvidence(
      [orphan({ runMarker: 'absent' })],
      [
        { worktree: null, agentPgid: 42 },
        { worktree: '/trees/gone', agentPgid: null },
      ],
    )[0]!.runMarker,
  ).toBe('absent')
})

test('an existing reason still wins over missing ownership evidence', () => {
  expect(
    automaticOrphanReclaimDecision(orphan({ runMarker: 'absent', ageSeconds: 1 }), new Set()),
  ).toEqual({ reclaim: false, reason: 'younger than 60000ms minimum age' })
  expect(
    automaticOrphanReclaimDecision(
      orphan({ runMarker: 'absent', command: `${PLATFORM_SLUG} recipe undo` }),
      new Set(),
    ),
  ).toEqual({ reclaim: false, reason: `${PLATFORM_SLUG}/orchestrator lifecycle process` })
  expect(
    automaticOrphanReclaimDecision(orphan({ runMarker: 'absent' }), new Set(['/trees/gone'])),
  ).toEqual({ reclaim: false, reason: 'tree belongs to a live run' })
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
