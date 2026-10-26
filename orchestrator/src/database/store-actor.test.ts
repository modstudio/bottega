import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  cachedHandleWriteRefusal,
  persistentReadOnlyRefusal,
  readerOpenMode,
  restrictedStoreActor,
  type StoreActorFacts,
  storeWriteRefusal,
} from './store-actor.ts'

/** The unrestricted caller: an operator command from the main checkout, on the main store. */
const operator: StoreActorFacts = {
  linkedWorktreeBinary: false,
  namedStoreOverride: false,
  namedStoreIsMainStore: true,
  operatorWriteInsistence: false,
  workerCaller: false,
  brokerChannel: false,
}

test('a worker caller is a restricted store actor whatever its binary location', () => {
  expect(restrictedStoreActor({ ...operator, workerCaller: true })).toBeTrue()
  expect(
    restrictedStoreActor({ ...operator, workerCaller: true, linkedWorktreeBinary: true }),
  ).toBeTrue()
})

test("the operator's write insistence lifts the linked-worktree condition alone", () => {
  expect(
    restrictedStoreActor({
      ...operator,
      linkedWorktreeBinary: true,
      operatorWriteInsistence: true,
    }),
  ).toBeFalse()
  expect(
    restrictedStoreActor({ ...operator, workerCaller: true, operatorWriteInsistence: true }),
  ).toBeTrue()
})

test('the ask server is the one worker-classified caller that writes the store', () => {
  expect(restrictedStoreActor({ ...operator, workerCaller: true, brokerChannel: true })).toBeFalse()
})

test('a linked-worktree binary is restricted on the main store and free on a store it names elsewhere', () => {
  expect(restrictedStoreActor({ ...operator, linkedWorktreeBinary: true })).toBeTrue()
  expect(
    restrictedStoreActor({
      ...operator,
      linkedWorktreeBinary: true,
      namedStoreOverride: true,
      namedStoreIsMainStore: true,
    }),
  ).toBeTrue()
  expect(
    restrictedStoreActor({
      ...operator,
      linkedWorktreeBinary: true,
      namedStoreOverride: true,
      namedStoreIsMainStore: false,
    }),
  ).toBeFalse()
})

test('a refused write reports the condition that refused it and what clears it', () => {
  expect(storeWriteRefusal(true)).toContain(
    'refusing to write orchestrator rows from a worker process',
  )
  expect(storeWriteRefusal(true)).toContain(
    'invariant: A worker writes the shared store only through its ask server, the one declared broker channel; a store under OS temporary state is not the shared store.',
  )
  expect(storeWriteRefusal(true)).toContain(
    'cleared by: ask, message or note through the worker channel',
  )
  // The one edit a refused worker can make for itself, named with the resolved directory.
  expect(storeWriteRefusal(true)).toContain(
    `set BOTTEGA_ORCHESTRATOR_DB to a scratch copy under the OS temporary directory (${resolve(tmpdir())})`,
  )
  expect(storeWriteRefusal(false)).toContain(
    'refusing to write run or project rows to the registered main store from a linked worktree',
  )
})

test('a cached handle opened read-only refuses a later write and is never silently reopened', () => {
  const refusal = cachedHandleWriteRefusal('read-only', true, '/state/orchestrator/orchestrator.db')
  expect(refusal).toContain(
    'refusing to write the orchestrator store through a process handle opened read-only: /state/orchestrator/orchestrator.db',
  )
  expect(refusal).toContain(
    'condition: this process opened the store read-only earlier, before its write authority was declared.',
  )
  // A writable handle serves the write, and a read request is untouched.
  expect(cachedHandleWriteRefusal('read-write', true, '/state/orchestrator.db')).toBeNull()
  expect(cachedHandleWriteRefusal('read-only', false, '/state/orchestrator.db')).toBeNull()
  expect(cachedHandleWriteRefusal(null, true, '/state/orchestrator.db')).toBeNull()
})

test('a persistent handle never takes the immutable open and a one-shot reader still may', () => {
  expect(readerOpenMode('persistent', 'read-only-immutable')).toBe('read-only')
  expect(readerOpenMode('persistent', 'read-only')).toBe('read-only')
  expect(readerOpenMode('persistent', 'read-write')).toBe('read-write')
  expect(readerOpenMode('one-shot', 'read-only-immutable')).toBe('read-only-immutable')
  expect(readerOpenMode('one-shot', 'read-only')).toBe('read-only')
})

test('a persistent reader that cannot be opened read-only names the condition, never the snapshot', () => {
  const refusal = persistentReadOnlyRefusal({
    path: '/state/orchestrator/orchestrator.db',
    storeDirectory: '/state/orchestrator',
    walOrShmSidecarPresent: false,
    storeDirectoryWritable: false,
    failure: 'unable to open database file',
  })
  expect(refusal).toContain(
    'refusing to read the orchestrator store from a long-lived restricted process: /state/orchestrator/orchestrator.db',
  )
  expect(refusal).toContain(
    'invariant: A persistent reader must see every later writer, so it never takes the immutable open',
  )
  expect(refusal).toContain(
    'condition: the store has no -wal/-shm sidecar and a read-only connection cannot establish one, and this process cannot write the store directory (/state/orchestrator)',
  )
  expect(refusal).toContain('unable to open database file')
  expect(refusal).toContain(
    `set BOTTEGA_ORCHESTRATOR_DB to a scratch copy under the OS temporary directory (${resolve(tmpdir())})`,
  )
})

test('a sidecar-less store the process could write still names the sidecar as the condition', () => {
  const refusal = persistentReadOnlyRefusal({
    path: '/state/orchestrator/orchestrator.db',
    storeDirectory: '/state/orchestrator',
    walOrShmSidecarPresent: false,
    storeDirectoryWritable: true,
    failure: 'unable to open database file',
  })
  expect(refusal).toContain(
    'condition: the store has no -wal/-shm sidecar and a read-only connection cannot establish one: unable to open database file',
  )
  expect(refusal).not.toContain('cannot write the store directory')
})

test('a read-only open that failed for another reason still reports the exact failure', () => {
  const refusal = persistentReadOnlyRefusal({
    path: '/state/orchestrator/orchestrator.db',
    storeDirectory: '/state/orchestrator',
    walOrShmSidecarPresent: true,
    storeDirectoryWritable: true,
    failure: 'database is locked',
  })
  expect(refusal).toContain('condition: the read-only open was refused: database is locked')
})
