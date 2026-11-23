// concern: doc-hosted-client
/** Binds project-addressed hosted document operations to the register's destination. */

import { hasRecordIdShape } from '../../../shared/record-id.ts'
import type { RecordWriteOwner } from '../../../shared/record-write-space.ts'
import { db } from '../database/db.ts'
import { projectRowByName } from '../project/projects.ts'
import { effectiveProjectSpace } from '../project-space.ts'
import {
  type RecordApiClient,
  RecordApiRequestError,
  recordApiClient,
} from '../record/record-api-client.ts'
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

function assertFullBodyWrite(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const input = value as Record<string, unknown>
  const rows = Array.isArray(input.rows) ? input.rows : []
  const candidates = [input, input.doc, ...rows]
  if (
    candidates.some(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        (candidate as Record<string, unknown>).bodyTrimmed === true,
    )
  ) {
    throw new Error(
      'refusing to write a frontmatter-only document row; read the full document body, then retry',
    )
  }
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
  const seededSpaceId = effectiveProjectSpace(db(), projectName)
  const bindDestination = (destination: { destinationSpaceId: string }): HostedDocClient => ({
    listDocs: (query) =>
      client.listDocs(query, query.acrossReadableSpaces ? undefined : destination),
    getDoc: (id) => client.getDoc(id, destination),
    getDocRevision: (id) => client.getDocRevision(id),
    listRevisions: (id) => client.listRevisions(id, destination),
    upsertDoc: async (input) => {
      assertFullBodyWrite(input)
      return client.upsertDoc({ ...input, projectId }, destination)
    },
    reorderDocs: (input) => client.reorderDocs(input, destination),
    importDoc: async (input) => {
      assertFullBodyWrite(input)
      return client.importDoc({ ...input, doc: { ...input.doc, projectId } }, destination)
    },
    importCanon: async (input) => {
      assertFullBodyWrite(input)
      return client.importCanon(input, destination)
    },
    deleteDoc: (id, input) => client.deleteDoc(id, input, destination),
    consumeDoc: (id, input) => client.consumeDoc(id, input, destination),
    restoreDoc: (id, input) => client.restoreDoc(id, input, destination),
    applySettingsPermission: (input) => client.applySettingsPermission(input, destination),
    applySettingsAutoMode: (input) => client.applySettingsAutoMode(input, destination),
  })
  if (!seededSpaceId) return bindDestination(await recordWriteDestination(client, owner))

  let destinationRead: ReturnType<typeof recordWriteDestination> | undefined
  const confirmedDestination = () => (destinationRead ??= recordWriteDestination(client, owner))
  const confirmedClient = async () => bindDestination(await confirmedDestination())
  return {
    listDocs: async (query) => {
      if (query.acrossReadableSpaces || query.cursor) {
        return (await confirmedClient()).listDocs(query)
      }
      const speculativePage = client.listDocs(query, { destinationSpaceId: seededSpaceId }).then(
        (page) => ({ status: 'fulfilled' as const, page }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      )
      const [destination, speculative] = await Promise.all([
        confirmedDestination(),
        speculativePage,
      ])
      if (destination.destinationSpaceId !== seededSpaceId) {
        return client.listDocs(query, destination)
      }
      if (speculative.status === 'rejected') throw speculative.error
      return speculative.page
    },
    getDoc: async (id) => (await confirmedClient()).getDoc(id),
    getDocRevision: async (id) => (await confirmedClient()).getDocRevision(id),
    listRevisions: async (id) => (await confirmedClient()).listRevisions(id),
    upsertDoc: async (input) => (await confirmedClient()).upsertDoc(input),
    reorderDocs: async (input) => (await confirmedClient()).reorderDocs(input),
    importDoc: async (input) => (await confirmedClient()).importDoc(input),
    importCanon: async (input) => (await confirmedClient()).importCanon(input),
    deleteDoc: async (id, input) => (await confirmedClient()).deleteDoc(id, input),
    consumeDoc: async (id, input) => (await confirmedClient()).consumeDoc(id, input),
    restoreDoc: async (id, input) => (await confirmedClient()).restoreDoc(id, input),
    applySettingsPermission: async (input) =>
      (await confirmedClient()).applySettingsPermission(input),
    applySettingsAutoMode: async (input) => (await confirmedClient()).applySettingsAutoMode(input),
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

export function isMissingHostedDoc(cause: unknown): boolean {
  return cause instanceof RecordApiRequestError && cause.status === 404
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
