// concern: doc-hosted-client
/** Binds project-addressed hosted document operations to the register's destination. */

import { projectRowByName } from '../project/projects.ts'
import { type RecordApiClient, recordApiClient } from '../record/record-api-client.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import { docWriteProjectName } from './doc-write-allowed.ts'

type HostedDocClient = Pick<
  RecordApiClient,
  | 'listDocs'
  | 'getDoc'
  | 'listRevisions'
  | 'upsertDoc'
  | 'importDoc'
  | 'importCanon'
  | 'deleteDoc'
  | 'consumeDoc'
  | 'restoreDoc'
  | 'applySettingsPermission'
>

export async function hostedDocClient(
  scope: string,
  subject: string | null,
): Promise<HostedDocClient> {
  const client = recordApiClient()
  const projectName = docWriteProjectName(scope, subject)
  const destination = projectName
    ? {
        destinationSpaceId: await requireProjectRecordDestination(
          projectName,
          projectRowByName(projectName)?.settings,
          client,
        ),
      }
    : undefined
  return {
    listDocs: (query) => client.listDocs(query, destination),
    getDoc: (id) => client.getDoc(id, destination),
    listRevisions: (id) => client.listRevisions(id, destination),
    upsertDoc: (input) => client.upsertDoc(input, destination),
    importDoc: (input) => client.importDoc(input, destination),
    importCanon: (input) => client.importCanon(input, destination),
    deleteDoc: (id, input) => client.deleteDoc(id, input, destination),
    consumeDoc: (id, input) => client.consumeDoc(id, input, destination),
    restoreDoc: (id, input) => client.restoreDoc(id, input, destination),
    applySettingsPermission: (input) => client.applySettingsPermission(input, destination),
  }
}
