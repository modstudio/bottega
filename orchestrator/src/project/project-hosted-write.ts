// concern: project-hosted-write
/** Applies project-register write authority at the hosted-record boundary. */

import { recordApiClient } from '../record/record-api-client.ts'
import { applyRecordWriteAuthority, requireHostedRecord } from '../record/record-write-authority.ts'
import type { ProjectSettings, StoredProjectSettings } from './project-settings.ts'

export async function writeProjectToHostedRecord(p: {
  name: string
  previousName?: string
  path: string
  stack?: string | null
  canon?: boolean
  settings?: ProjectSettings | StoredProjectSettings
  retiredAt?: string | null
}): Promise<void> {
  await applyRecordWriteAuthority({
    local: () => undefined,
    hosted: () =>
      recordApiClient().upsertProject({
        name: p.name,
        previousName: p.previousName,
        path: p.path.replace(/\/$/, ''),
        stack: p.stack ?? null,
        canon: Boolean(p.canon),
        settings: p.settings ?? {},
        retiredAt: p.retiredAt ?? null,
      }),
  })
}

export async function retireProjectInHostedRecord(name: string): Promise<void> {
  await applyRecordWriteAuthority({
    local: () => undefined,
    hosted: () => recordApiClient().retireProject(name),
  })
}

export function requireHostedProjectPush(): void {
  requireHostedRecord('orch project push')
}
