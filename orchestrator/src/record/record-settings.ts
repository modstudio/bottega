// concern: record-settings
/** Applies tenant-bound settings edits through the hosted document service. Must not know HTTP or local stores. */
import { decideDocRevisionWrite } from '../doc/doc-write-allowed.ts'
import {
  type PermissionList,
  parseStoredOwnedSettings,
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

export type RecordSettingsPermissionDependencies = {
  listDocs: typeof listRecordDocs
  listRevisions: typeof listRecordDocRevisions
  upsertDoc: typeof upsertRecordDoc
}

const recordSettingsDependencies: RecordSettingsPermissionDependencies = {
  listDocs: listRecordDocs,
  listRevisions: listRecordDocRevisions,
  upsertDoc: upsertRecordDoc,
}

export async function applyRecordSettingsPermission(
  input: RecordSettingsPermissionInput,
  dependencies: RecordSettingsPermissionDependencies = recordSettingsDependencies,
): Promise<RecordSettingsPermissionResult> {
  const subject = input.target.kind === 'project' ? input.target.project : null
  const owner = input.target.kind === 'user' ? input.userId : null
  const rows = await dependencies.listDocs({
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
      candidate.slug === SETTINGS_SLUG &&
      candidate.owner === owner &&
      candidate.subject === subject,
  )
  if (!row) throw new RecordDocError('settings doc not found', 404)
  const revisions = await dependencies.listRevisions({ ...input, id: row.id })
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
  const written = await dependencies.upsertDoc({
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
    expectedRevision: input.expectedRevision,
  })
  return { revision: written.revisionId, permissions: edit.permissions }
}
