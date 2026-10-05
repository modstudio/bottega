// concern: project-hosted-write
/** Applies project-register write authority at the hosted-record boundary. */

import { readRecordInstallBinding, rememberHostedRecord } from '../record/install-binding.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import type { ProjectSettings } from './project-settings.ts'
import { decideProjectWrite } from './project-write-decision.ts'

const BOUND_PROJECT_WRITE_REFUSAL =
  'this install is bound to a hosted record, but ORCH_RECORD_API_URL is not set in this environment\n' +
  'cleared by: orch record doctor'

function currentProjectWriteDecision() {
  return decideProjectWrite({
    recordApiUrlSet: Boolean(process.env.ORCH_RECORD_API_URL?.trim()),
    installBound: readRecordInstallBinding().bound,
  })
}

async function applyHostedProjectWrite(action: () => Promise<unknown>): Promise<void> {
  const decision = currentProjectWriteDecision()
  if (decision === 'local-authoritative') return
  if (decision === 'refused') throw new Error(BOUND_PROJECT_WRITE_REFUSAL)
  await action()
  rememberHostedRecord()
}

export async function writeProjectToHostedRecord(p: {
  name: string
  previousName?: string
  path: string
  stack?: string | null
  canon?: boolean
  settings?: ProjectSettings
  retiredAt?: string | null
}): Promise<void> {
  await applyHostedProjectWrite(() =>
    recordApiClient().upsertProject({
      name: p.name,
      previousName: p.previousName,
      path: p.path.replace(/\/$/, ''),
      stack: p.stack ?? null,
      canon: Boolean(p.canon),
      settings: p.settings ?? {},
      retiredAt: p.retiredAt ?? null,
    }),
  )
}

export async function retireProjectInHostedRecord(name: string): Promise<void> {
  await applyHostedProjectWrite(() => recordApiClient().retireProject(name))
}

export function requireHostedProjectPush(): void {
  const decision = currentProjectWriteDecision()
  if (decision === 'refused') throw new Error(BOUND_PROJECT_WRITE_REFUSAL)
  if (decision === 'local-authoritative') {
    throw new Error(
      'no hosted record is configured for this install; set ORCH_RECORD_API_URL before running `orch project push`',
    )
  }
}
