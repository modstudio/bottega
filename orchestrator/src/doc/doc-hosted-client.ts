// concern: doc-hosted-client
/** Binds project-addressed hosted document operations to the register's destination. */

import { hasRecordIdShape } from '../../../shared/record-id.ts'
import type { RecordWriteOwner } from '../../../shared/record-write-space.ts'
import { projectRowByName } from '../project/projects.ts'
import { type RecordApiClient, recordApiClient } from '../record/record-api-client.ts'
import { recordWriteDestination } from '../record/record-write-destination.ts'
import { docWriteProjectName } from './doc-write-allowed.ts'

type BindWriteDestination<Method> = Method extends (
  ...args: [...infer Args, { destinationSpaceId: string }]
) => infer Result
  ? (...args: Args) => Result
  : Method

type HostedDocMethod =
  | 'listDocs'
  | 'getDoc'
  | 'getDocRevision'
  | 'listRevisions'
  | 'upsertDoc'
  | 'reorderDocs'
  | 'importDoc'
  | 'importCanon'
  | 'deleteDoc'
  | 'consumeDoc'
  | 'restoreDoc'
  | 'applySettingsPermission'
  | 'applySettingsAutoMode'

type HostedDocClient = {
  [Method in HostedDocMethod]: BindWriteDestination<RecordApiClient[Method]>
}

type HostedPersonalDocQuery = Parameters<HostedDocClient['listDocs']>[0]
type HostedDocListResult = {
  items: Record<string, unknown>[]
  unreadable: Array<{ id: string; reason: string }>
}

export async function hostedDocClient(
  scope: string,
  subject: string | null,
  suppliedOwner?: RecordWriteOwner,
): Promise<HostedDocClient> {
  const client = recordApiClient()
  const projectName = docWriteProjectName(scope, subject)
  const projectId = projectName ? (projectRowByName(projectName)?.recordId ?? null) : null
  const owner = suppliedOwner ?? docOwner(projectName)
  const destination = await recordWriteDestination(client, owner)
  return {
    listDocs: (query) =>
      client.listDocs(query, query.acrossReadableSpaces ? undefined : destination),
    getDoc: (id) => client.getDoc(id, destination),
    getDocRevision: (id) => client.getDocRevision(id),
    listRevisions: (id) => client.listRevisions(id, destination),
    upsertDoc: (input) => client.upsertDoc({ ...input, projectId }, destination),
    reorderDocs: (input) => client.reorderDocs(input, destination),
    importDoc: (input) =>
      client.importDoc({ ...input, doc: { ...input.doc, projectId } }, destination),
    importCanon: (input) => client.importCanon(input, destination),
    deleteDoc: (id, input) => client.deleteDoc(id, input, destination),
    consumeDoc: (id, input) => client.consumeDoc(id, input, destination),
    restoreDoc: (id, input) => client.restoreDoc(id, input, destination),
    applySettingsPermission: (input) => client.applySettingsPermission(input, destination),
    applySettingsAutoMode: (input) => client.applySettingsAutoMode(input, destination),
  }
}

export async function listAllHostedDocs(
  list: HostedDocClient['listDocs'],
  query: HostedPersonalDocQuery,
): Promise<HostedDocListResult> {
  const items: Record<string, unknown>[] = []
  const unreadable: HostedDocListResult['unreadable'] = []
  let cursor: string | null = null
  do {
    const page = await list({ ...query, limit: 100, cursor })
    items.push(...page.items)
    unreadable.push(...(page.unreadable ?? []))
    cursor = page.nextCursor
  } while (cursor)
  return { items, unreadable }
}

/** Read the user settings inputs from the signed-in user's personal space. */
export async function readHostedUserSettingsDocuments(): Promise<{
  settings: Record<string, unknown>[]
  canon: Record<string, unknown>[]
}> {
  const client = await hostedDocClient('settings', null)
  const [settings, canon] = await Promise.all([
    listAllHostedDocs(client.listDocs, { scope: 'settings', subject: null }),
    listAllHostedDocs(client.listDocs, { scope: 'canon', subject: null, status: 'current' }),
  ])
  const unreadable = [...settings.unreadable, ...canon.unreadable]
  if (unreadable.length > 0) {
    throw new Error(
      'refusing settings apply: hosted personal document rows could not be read: ' +
        unreadable.map(({ id, reason }) => `${id}: ${reason}`).join('; '),
    )
  }
  return { settings: settings.items, canon: canon.items }
}

/** Read one shared-parser document reference through the hosted document store. */
export async function readHostedDocReference(address: string): Promise<Record<string, unknown>> {
  if (hasRecordIdShape(address)) return recordApiClient().getDoc(address)
  const [scope, rawSubject, ...slugParts] = address.split('/')
  const slug = slugParts.join('/')
  if (!scope || !rawSubject || !slug)
    throw new Error(`invalid document address ${JSON.stringify(address)}`)
  const subject = rawSubject === '_' ? null : rawSubject
  return (await hostedDocClient(scope, subject)).getDoc(encodeURIComponent(slug))
}

function docOwner(projectName: string | null): RecordWriteOwner {
  if (projectName) return { kind: 'project', name: projectName }
  return { kind: 'personal' }
}

export function contextTaskOwner(
  task: { project: string } | undefined,
): RecordWriteOwner | undefined {
  return task ? { kind: 'task', projectName: task.project } : undefined
}
