import { expect, test } from 'bun:test'
import { decideStoreAccess } from '../../../shared/store-access.ts'
import { restrictedStoreActor, type StoreActorFacts, storeWriteRefusal } from './db.ts'

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

test('a worker is refused the shared store and still writes the temporary store its test leg mints', () => {
  const actor = restrictedStoreActor({ ...operator, workerCaller: true })
  expect(
    decideStoreAccess({
      restrictedActor: actor,
      storePathUnderTemporaryRoot: false,
      walOrShmSidecarPresent: false,
    }).writesRefused,
  ).toBeTrue()
  expect(
    decideStoreAccess({
      restrictedActor: actor,
      storePathUnderTemporaryRoot: true,
      walOrShmSidecarPresent: false,
    }),
  ).toEqual({ openMode: 'read-write', writesRefused: false, migrationsRefused: false })
})

test('a refused write reports the condition that refused it and what clears it', () => {
  expect(storeWriteRefusal(true)).toContain(
    'refusing to write orchestrator rows from a worker process',
  )
  expect(storeWriteRefusal(true)).toContain(
    'invariant: A worker writes the store only through its ask server, the one declared broker channel.',
  )
  expect(storeWriteRefusal(true)).toContain(
    'cleared by: ask, message or note through the worker channel',
  )
  expect(storeWriteRefusal(false)).toContain(
    'refusing to write run or project rows to the registered main store from a linked worktree',
  )
})
