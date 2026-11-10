// concern: doc-hosted-client
/** Binds project-addressed hosted document operations to the register's destination. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { type RecordWriteOwner, recordWriteSpace } from '../../../shared/record-write-space.ts'
import { declaredRecordSpace } from '../project/declared-record-space.ts'
import { projectAt, projectRowByName, projects } from '../project/projects.ts'
import {
  type RecordApiClient,
  RecordApiRequestError,
  recordApiClient,
} from '../record/record-api-client.ts'
import { resolveContextTaskByRecordId } from './context-write-adapter.ts'
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
  suppliedOwner?: RecordWriteOwner,
): Promise<HostedDocClient> {
  const client = recordApiClient()
  const projectName = docWriteProjectName(scope, subject)
  const projectId = projectName ? (projectRowByName(projectName)?.recordId ?? null) : null
  const owner = suppliedOwner ?? (await docOwner(scope, subject, projectName))
  const identity = await client.whoami()
  const registered = [...projects(), ...projects({ retired: true })]
  const decision = recordWriteSpace(owner, {
    declaredSpaces: Object.fromEntries(
      registered.map((project) => [project.name, declaredRecordSpace(project.settings)]),
    ),
    personalSpaceId: identity.personalSpaceId,
    memberships: parseRecordSpaceMemberships(identity.memberships),
  })
  if ('refused' in decision) throw new RecordApiRequestError(decision.remedy, 'refused', 409)
  const destination = { destinationSpaceId: decision.spaceId }
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

async function docOwner(
  scope: string,
  subject: string | null,
  projectName: string | null,
): Promise<RecordWriteOwner | null> {
  if (projectName) return { kind: 'project', name: projectName }
  if (scope !== 'context') return { kind: 'personal' }
  if (subject?.startsWith('session:')) {
    return { kind: 'session', checkoutProject: projectAt(process.cwd())?.name ?? null }
  }
  if (subject?.startsWith('task:')) {
    const task = await resolveContextTaskByRecordId(subject.slice('task:'.length))
    if (task) return { kind: 'task', projectName: task.project }
    throw new RecordApiRequestError(
      `task context owner could not be resolved; retry with \`${PLATFORM_SLUG} agent context set --task <KEY>\``,
      'refused',
      409,
    )
  }
  return null
}

export function contextTaskOwner(
  task: { project: string } | undefined,
): RecordWriteOwner | undefined {
  return task ? { kind: 'task', projectName: task.project } : undefined
}
