// concern: record-settings
/** Applies tenant-bound settings edits through the hosted document service. Must not know HTTP or local stores. */
import { decideDocRevisionWrite } from '../doc/doc-write-allowed.ts'
import {
  parseStoredOwnedSettings,
  type PermissionList,
  SETTINGS_SCOPE,
  SETTINGS_SLUG,
  serializeOwnedSettings,
} from '../settings/settings.ts'
import {
  editSettingsPermission,
  type SettingsPermissionOperation,
} from '../settings/settings-permission.ts'
import {
  listRecordDocRevisions,
  listRecordDocs,
  RecordDocError,
  upsertRecordDoc,
} from './record-docs.ts'

type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
export type RecordSettingsPermissionInput = Tenant & {
  target: { kind: 'user' } | { kind: 'project'; project: string }
  list: PermissionList
  rule: string
  operation: SettingsPermissionOperation
  reason: string
  expectedRevision: string
}

export type RecordSettingsPermissionResult = {
  revision: string
  permissions: Record<PermissionList, string[]>
}

export async function applyRecordSettingsPermission(
  input: RecordSettingsPermissionInput,
): Promise<RecordSettingsPermissionResult> {
  const subject = input.target.kind === 'project' ? input.target.project : null
  const owner = input.target.kind === 'user' ? input.userId : null
  const rows = await listRecordDocs({
    ...input,
    scope: SETTINGS_SCOPE,
    subject,
    limit: 2,
    cursor: null,
    includeDeleted: false,
    acrossReadableSpaces: false,
  })
  const row = rows.find(
    (candidate) =>
      candidate.slug === SETTINGS_SLUG && candidate.owner === owner && candidate.subject === subject,
  )
  if (!row) throw new RecordDocError('settings doc not found', 404)
  const revisions = await listRecordDocRevisions({ ...input, id: row.id })
  const current = revisions?.[0]?.id ?? null
  const decision = decideDocRevisionWrite({
    expected: input.expectedRevision,
    current,
    isCreate: false,
    scope: SETTINGS_SCOPE,
  })
  if (!decision.allow) throw new RecordDocError(decision.reason, 409)
  const edit = editSettingsPermission(parseStoredOwnedSettings(row.body), input)
  if (!edit.changed) return { revision: current!, permissions: edit.permissions }
  const written = await upsertRecordDoc({
    ...input,
    scope: SETTINGS_SCOPE,
    subject,
    owner,
    slug: SETTINGS_SLUG,
    title: SETTINGS_SLUG,
    body: serializeOwnedSettings(edit.settings),
    delivery: 'demand',
    projectName: subject,
    author: 'hub-dashboard',
  })
  return { revision: written.revisionId, permissions: edit.permissions }
}
