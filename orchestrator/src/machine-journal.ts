// concern: machine journal
/** Shapes the store-free release probe consumed by the updater. */

import { z } from 'zod'
import type { InstallationIdentity } from '../../shared/install-root.ts'
import type { MigrationJournalEntryWithHash } from './database/migration-compatibility.ts'

export const MACHINE_JOURNAL_SCHEMA_VERSION = 1

const installationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('distribution'),
      root: z.string(),
      version: z.string(),
      commit: z.string(),
      built: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('checkout'),
      root: z.string(),
      version: z.string(),
    })
    .strict(),
])

const journalEntrySchema = z
  .object({
    idx: z.number().int().nonnegative(),
    when: z.number().int().nonnegative(),
    tag: z.string().min(1),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    compatibility: z.string().min(1).nullable(),
  })
  .strict()

export const MACHINE_JOURNAL_SCHEMA = z
  .object({
    schemaVersion: z.literal(MACHINE_JOURNAL_SCHEMA_VERSION),
    installation: installationSchema,
    orchestratorJournal: z.array(journalEntrySchema),
  })
  .strict()

export type MachineJournal = z.infer<typeof MACHINE_JOURNAL_SCHEMA>

/** Shape install identity and embedded migration metadata without consulting machine state. */
export function shapeMachineJournal(
  identity: InstallationIdentity,
  entries: readonly MigrationJournalEntryWithHash[],
): MachineJournal {
  const installation =
    identity.kind === 'distribution'
      ? {
          kind: identity.kind,
          root: identity.root,
          version: identity.manifest.version,
          commit: identity.manifest.commit,
          built: identity.manifest.built,
        }
      : identity

  return {
    schemaVersion: MACHINE_JOURNAL_SCHEMA_VERSION,
    installation,
    orchestratorJournal: entries.map((entry) => ({
      idx: entry.idx,
      when: entry.when,
      tag: entry.tag,
      hash: entry.hash,
      compatibility: entry.compatibility ?? null,
    })),
  }
}
