import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { restrictedStoreActor, type StoreActorFacts, storeWriteRefusal } from './store-actor.ts'

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
