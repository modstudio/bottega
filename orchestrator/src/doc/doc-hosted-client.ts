// concern: doc-hosted-client
/** Binds project-addressed hosted document operations to the register's destination. */

import { resolvePersonalItemSpace } from '../../../shared/personal-item-space.ts'
import { projectRowByName } from '../project/projects.ts'
import {
  type RecordApiClient,
  RecordApiRequestError,
  recordApiClient,
} from '../record/record-api-client.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import { docWriteProjectName } from './doc-write-allowed.ts'

type HostedDocClient = Pick<
  RecordApiClient,
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
>

export async function hostedDocClient(
  scope: string,
  subject: string | null,
): Promise<HostedDocClient> {
  const client = recordApiClient()
  const projectName = docWriteProjectName(scope, subject)
  const projectId = projectName ? (projectRowByName(projectName)?.recordId ?? null) : null
  const destination = projectName
    ? {
        destinationSpaceId: await requireProjectRecordDestination(
          projectName,
          projectRowByName(projectName)?.settings,
          client,
        ),
      }
    : await (async () => {
        const identity = await client.whoami()
        const spaceId = resolvePersonalItemSpace(
          {
            userId: identity.user.id,
            activeSpaceId: identity.activeSpaceId,
            personalSpaceId: identity.personalSpaceId,
          },
          { kind: 'document', scope, subject, ownerUserId: identity.user.id },
        )
        if (!spaceId && (scope === 'settings' || scope === 'canon') && subject === null) {
          throw new RecordApiRequestError('personal space is not provisioned', 'refused', 409)
        }
        return spaceId ? { destinationSpaceId: spaceId } : undefined
      })()
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
