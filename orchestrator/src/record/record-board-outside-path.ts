// concern: record-board-outside-path
/** Chooses and applies the outside branch of hosted board writes. */

import type { SQL } from 'bun'
import type { BoardPurpose } from '../../../shared/board-purpose.ts'
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
import { audienceIsProjectScoped, hostedProjectNameForAudience } from './record-board-scope.ts'
import type { BoardTenant } from './record-board-tx.ts'
import {
  hasProjectWriteMembership,
  insertOutsideBoardMessage,
  isOutsideIntakeProject,
} from './record-outside-write.ts'

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

export async function postOutsidePath(
  tx: SQL,
  values: OutsidePostInput,
  ports: Ports,
): Promise<HostedBoardMessage | null> {
  const { input, audience } = values
  if (!input.projectId || !audienceIsProjectScoped(audience)) return null
  if (await hasProjectWriteMembership(tx, input.userId, input.projectId)) return null
  if (!(await isOutsideIntakeProject(tx, input.projectId))) return null
  const audienceProject = hostedProjectNameForAudience(audience, input.project)
  if (input.project && audienceProject && input.project !== audienceProject)
    throw new RecordBoardError(
      `board project ${input.project} does not match audience ${input.audience}`,
      400,
    )
  const authorProjectId = input.project ? input.projectId : null
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
    scopeProjectIds: [input.projectId],
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
    projectId: input.projectId,
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
  if (await hasProjectWriteMembership(tx, input.userId, scope[0]!)) return null
  if (!(await isOutsideIntakeProject(tx, scope[0]!))) return null
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
