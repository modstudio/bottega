// concern: record-board-outside-path
/** Chooses and applies the outside branch of hosted board writes. */

import type { SQL } from 'bun'
import type { BoardPurpose } from '../../../shared/board-purpose.ts'
import {
  type OutsideIntake,
  outsideAdmission,
  resolveOutsideIntake,
} from '../../../shared/outside-write-adapter.ts'
import type { Audience } from '../board/board-policy.ts'
import type { BoardTag } from '../board/board-tags.ts'
import { requireOwnedHostedRunAndMachine } from './record-board-author.ts'
import {
  type HostedBoardCreateContent,
  type HostedBoardMessage,
  type HostedBoardPostInput,
  type HostedBoardReplyInput,
  RecordBoardError,
} from './record-board-contract.ts'
import {
  audienceIsProjectScoped,
  hostedProjectNameForAudience,
  parseHostedAudience,
} from './record-board-scope.ts'
import type { BoardTenant } from './record-board-tx.ts'
import { insertOutsideBoardMessage, isOutsideIntakeProject } from './record-outside-write.ts'

type Ports = {
  existing(
    tx: SQL,
    id: string,
    requested: HostedBoardCreateContent,
  ): Promise<HostedBoardMessage | null>
  insertTags(tx: SQL, id: string, tags: BoardTag[]): Promise<void>
  view(tx: SQL, id: string, clock: number): Promise<HostedBoardMessage>
}

export type OutsidePostInput = {
  input: BoardTenant & HostedBoardPostInput
  audience: Audience
  purpose: BoardPurpose
  ackRequired: boolean
  ackDeadline: string | null
  expiresAt: string
  session: string | null
  senderTags: BoardTag[]
  tags: BoardTag[]
  clock: number
}

function boardIntake(intake: OutsideIntake): Extract<OutsideIntake, { kind: 'intake' }> | null {
  if (intake.kind === 'multiple') throw new RecordBoardError(intake.refusal, 409)
  return intake.kind === 'intake' ? intake : null
}

async function outsideAdmissionRefusal(tx: SQL, userId: string, spaceId: string): Promise<boolean> {
  const admission = await outsideAdmission(tx, userId, spaceId)
  if (admission.kind === 'outside') return false
  if (admission.kind === 'refused')
    throw new RecordBoardError(`${admission.error}; ${admission.remedy}`, 403)
  return admission.kind === 'member'
}

export async function resolveOutsideReplyProjectId(
  tx: SQL,
  audience: Audience | null,
  project: string | undefined,
  projectId: string | null | undefined,
): Promise<string | null> {
  if (projectId) return projectId
  const audienceProject = audience ? hostedProjectNameForAudience(audience, project) : null
  if (
    project &&
    audienceProject &&
    audience &&
    (audience.kind === 'project' || audience.kind === 'workers') &&
    project !== audienceProject
  )
    throw new RecordBoardError(
      `board project ${project} does not match audience project:${audienceProject}`,
      400,
    )
  const intake = audienceProject
    ? boardIntake(await resolveOutsideIntake(tx, audienceProject))
    : null
  return intake?.projectId ?? null
}

export async function postOutsidePath(
  tx: SQL,
  values: OutsidePostInput,
  ports: Ports,
): Promise<HostedBoardMessage | null> {
  const { input, audience } = values
  const audienceProject = hostedProjectNameForAudience(audience, input.project)
  if (!audienceIsProjectScoped(audience) || !audienceProject) return null
  const projectId = input.projectId
  if (projectId && !(await isOutsideIntakeProject(tx, projectId))) return null
  const intake = boardIntake(
    await resolveOutsideIntake(
      tx,
      input.projectId ? (input.project ?? audienceProject) : audienceProject,
    ),
  )
  const resolvedProjectId = projectId ?? intake?.projectId
  if (!resolvedProjectId || !intake || intake.projectId !== resolvedProjectId) return null
  if (!projectId && !(await isOutsideIntakeProject(tx, resolvedProjectId))) return null
  if (await outsideAdmissionRefusal(tx, input.userId, intake.spaceId)) return null
  if (input.project && audienceProject && input.project !== audienceProject)
    throw new RecordBoardError(
      `board project ${input.project} does not match audience ${input.audience}`,
      400,
    )
  const authorProjectId = input.project ? resolvedProjectId : null
  const requested: HostedBoardCreateContent = {
    kind: input.kind,
    purpose: values.purpose,
    audience: input.audience,
    title: input.title,
    body: input.body,
    ackRequired: values.ackRequired,
    ackDeadline: values.ackDeadline,
    expiresAt: values.expiresAt,
    threadRootId: null,
    scopeProjectIds: [resolvedProjectId],
    recipientUserIds: [],
    sharedSpaceReach: false,
    claimId: null,
    authorProjectId,
    senderTags: values.senderTags.map(({ kind, value }) => ({ kind, value })),
  }
  const same = await ports.existing(tx, input.id, requested)
  if (same) return same
  await requireOwnedHostedRunAndMachine(tx, input.userId, {
    runId: input.authorRunId,
    machineId: input.authorMachineId,
    runField: 'authorRunId',
    machineField: 'authorMachineId',
  })
  await insertOutsideBoardMessage(tx, {
    ...input,
    authorSession: values.session,
    authorProjectId,
    purpose: values.purpose,
    threadRootId: null,
    ackRequired: values.ackRequired,
    ackDeadline: values.ackDeadline,
    expiresAt: values.expiresAt,
    projectId: resolvedProjectId,
    createdAt: new Date(values.clock).toISOString(),
  })
  await ports.insertTags(tx, input.id, values.tags)
  return ports.view(tx, input.id, values.clock)
}

export async function replyOutsidePath(
  tx: SQL,
  input: BoardTenant & HostedBoardReplyInput & { rootId: string },
  root: Record<string, unknown>,
  scope: string[],
  authorProjectId: string | null,
  session: string | null,
  audience: string | null,
  clock: number,
  view: Ports['view'],
): Promise<HostedBoardMessage | null> {
  if (scope.length !== 1) return null
  if (!(await isOutsideIntakeProject(tx, scope[0]!))) return null
  const rootAudience = root.audience ? parseHostedAudience(String(root.audience)) : null
  const projectName = rootAudience
    ? hostedProjectNameForAudience(rootAudience, input.project)
    : null
  const intake = projectName ? boardIntake(await resolveOutsideIntake(tx, projectName)) : null
  if (!intake || intake.projectId !== scope[0]) return null
  if (await outsideAdmissionRefusal(tx, input.userId, intake.spaceId)) return null
  await requireOwnedHostedRunAndMachine(tx, input.userId, {
    runId: input.authorRunId,
    machineId: input.authorMachineId,
    runField: 'authorRunId',
    machineField: 'authorMachineId',
  })
  await insertOutsideBoardMessage(tx, {
    ...input,
    authorSession: session,
    authorProjectId,
    kind: 'reply',
    purpose: null,
    threadRootId: String(root.id),
    audience,
    title: null,
    ackRequired: false,
    ackDeadline: null,
    expiresAt: null,
    projectId: scope[0]!,
    createdAt: new Date(clock).toISOString(),
  })
  return view(tx, input.id, clock)
}
