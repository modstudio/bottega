type StoreOpenMode = 'read-write' | 'read-only' | 'read-only-immutable'

export type StoreAccessFacts = {
  restrictedActor: boolean
  storePathUnderTemporaryRoot: boolean
  walOrShmSidecarPresent: boolean
}

export type StoreAccessDecision = {
  openMode: StoreOpenMode
  writesRefused: boolean
  migrationsRefused: boolean
}

/** Decide store authority without knowing which concern owns the store. */
export function decideStoreAccess(facts: StoreAccessFacts): StoreAccessDecision {
  if (!facts.restrictedActor || facts.storePathUnderTemporaryRoot) {
    return { openMode: 'read-write', writesRefused: false, migrationsRefused: false }
  }
  return {
    openMode: facts.walOrShmSidecarPresent ? 'read-only' : 'read-only-immutable',
    writesRefused: true,
    migrationsRefused: true,
  }
}
