// concern: doc-hosted-client
/** Binds project-addressed hosted document operations to the register's destination. */

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
    listDocs: (query) => client.listDocs(query, destination),
    getDoc: (id) => client.getDoc(id, destination),
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

export function docOwner(projectName: string | null): RecordWriteOwner {
  if (projectName) return { kind: 'project', name: projectName }
  return { kind: 'personal' }
}

export function contextTaskOwner(
  task: { project: string } | undefined,
): RecordWriteOwner | undefined {
  return task ? { kind: 'task', projectName: task.project } : undefined
}
