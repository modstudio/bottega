// concern: record-no-destination-write-counter
/** Keeps only failed durable measurements in memory around an application-owned store port. */

import type { SQL } from 'bun'
import type {
  NoDestinationWrite,
  NoDestinationWriteReport,
  NoDestinationWriteStoreReport,
} from './record-no-destination-write-contract.ts'

export type NoDestinationWriteCounter = {
  record(decision: NoDestinationWrite, persist: () => Promise<void>): Promise<void>
  read(
    spaceIds: readonly string[],
    load: () => Promise<NoDestinationWriteStoreReport>,
  ): Promise<NoDestinationWriteReport>
}

export type NoDestinationWriteTelemetry = {
  counter: NoDestinationWriteCounter
  database: () => SQL
}

export function createNoDestinationWriteCounter(): NoDestinationWriteCounter {
  const unrecordedBySpace = new Map<string, number>()
  return {
    async record(decision, persist) {
      try {
        await persist()
        console.info('record-write no-destination', JSON.stringify(decision))
      } catch (error) {
        unrecordedBySpace.set(decision.spaceId, (unrecordedBySpace.get(decision.spaceId) ?? 0) + 1)
        console.error('record-write no-destination recording failed', error)
      }
    },
    async read(spaceIds, load) {
      const report = await load()
      return {
        ...report,
        unrecorded: spaceIds.reduce(
          (total, spaceId) => total + (unrecordedBySpace.get(spaceId) ?? 0),
          0,
        ),
      }
    },
  }
}
