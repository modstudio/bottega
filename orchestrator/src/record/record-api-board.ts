// concern: record-api-board
/** Hosted board HTTP routes. Must not know SQL or local execution. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import {
  BOARD_CHANGES_PAGE_LIMIT,
  type HostedBoardAcceptInput,
  type HostedBoardChange,
  type HostedBoardClaim,
  type HostedBoardFilingCompleteInput,
  type HostedBoardFilingFailInput,
  type HostedBoardMessage,
  type HostedBoardPostInput,
  type HostedBoardReceipt,
  type HostedBoardReceiptInput,
  type HostedBoardReplyInput,
  type HostedBoardSessionInput,
  type HostedBoardStatus,
  type HostedBoardTakeClaimInput,
  type HostedBoardThread,
} from './record-board-contract.ts'
import { type BoardTenant, hostedBoardStoreRefusal } from './record-board-tx.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity } }

const idSchema = z.string().uuid()
const isoSchema = z.string().datetime({ offset: true })
const sessionSchema = z.string().min(1).nullable().optional()
const headerValueSchema = z.string().refine((value) => !/[\r\n\u2028\u2029]/.test(value))
const postSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['notice', 'question']),
    audience: z.string().min(1),
    title: headerValueSchema,
    body: z.string(),
    ackRequired: z.boolean().optional(),
    ackDeadline: isoSchema.nullable().optional(),
    expiresAt: isoSchema,
    task: headerValueSchema.optional(),
    paths: z.array(headerValueSchema).optional(),
    topics: z.array(headerValueSchema).optional(),
    authorSession: sessionSchema,
    authorHarness: z.string().min(1).nullable().optional(),
    authorMachineId: idSchema.nullable().optional(),
    authorRunId: idSchema.nullable().optional(),
    project: z.string().min(1).optional(),
    currentTaskKey: z.string().min(1).nullable().optional(),
  })
  .strict()
const replySchema = z
  .object({
    id: idSchema,
    body: z.string(),
    authorSession: sessionSchema,
    authorHarness: z.string().min(1).nullable().optional(),
    authorMachineId: idSchema.nullable().optional(),
    authorRunId: idSchema.nullable().optional(),
  })
  .strict()
const sessionBody = z.object({ authorSession: sessionSchema }).strict()
const acceptSchema = z.object({ replyId: idSchema, authorSession: sessionSchema }).strict()
const filingCompleteSchema = z.object({ noteId: idSchema, authorSession: sessionSchema }).strict()
const filingFailSchema = z
  .object({ error: z.string().min(1), authorSession: sessionSchema })
  .strict()
const receiptSchema = z
  .object({
    messageId: idSchema,
    readerSession: z.string().min(1),
    audienceAtPosting: z.boolean(),
    delivered: z.boolean().optional(),
    acknowledged: z.boolean().optional(),
  })
  .strict()
const takeClaimSchema = z
  .object({
    id: idSchema,
    project: z.string().min(1),
    subject: headerValueSchema.min(1),
    durationMs: z.number().int().positive().optional(),
    runId: idSchema.nullable().optional(),
    note: headerValueSchema.optional(),
    holderSession: sessionSchema,
  })
  .strict()
const holderBody = z.object({ holderSession: sessionSchema }).strict()
const releaseTaskSchema = z.object({ project: z.string().min(1), key: z.string().min(1) }).strict()

export type RecordBoardDeps = {
  postBoardMessage(input: BoardTenant & HostedBoardPostInput): Promise<HostedBoardMessage>
  replyBoardMessage(
    input: BoardTenant & HostedBoardReplyInput & { rootId: string },
  ): Promise<HostedBoardMessage>
  withdrawBoardMessage(
    input: BoardTenant & HostedBoardSessionInput & { id: string },
  ): Promise<HostedBoardMessage>
  acceptBoardAnswer(
    input: BoardTenant & HostedBoardAcceptInput & { id: string },
  ): Promise<HostedBoardThread>
  takeBoardFilingLease(
    input: BoardTenant & HostedBoardSessionInput & { id: string },
  ): Promise<HostedBoardMessage>
  completeBoardFilingLease(
    input: BoardTenant & HostedBoardFilingCompleteInput & { id: string },
  ): Promise<HostedBoardMessage>
  failBoardFilingLease(
    input: BoardTenant & HostedBoardFilingFailInput & { id: string },
  ): Promise<HostedBoardMessage>
  readBoardThread(input: BoardTenant & { id: string }): Promise<HostedBoardThread>
  boardStatus(input: BoardTenant & { id: string }): Promise<HostedBoardStatus>
  putBoardReceipt(input: BoardTenant & HostedBoardReceiptInput): Promise<HostedBoardReceipt>
  listBoardChanges(
    input: BoardTenant & { after: string; limit?: number },
  ): Promise<{ items: HostedBoardChange[]; highestRevision: string | null }>
  takeBoardClaim(
    input: BoardTenant & HostedBoardTakeClaimInput,
  ): Promise<HostedBoardClaim & { action: 'taken' | 'renewed' | 'taken-over' }>
  renewBoardClaim(
    input: BoardTenant & { id: string; holderSession?: string | null },
  ): Promise<HostedBoardClaim>
  releaseBoardClaim(
    input: BoardTenant & { id: string; holderSession?: string | null },
  ): Promise<HostedBoardClaim>
  listBoardClaims(input: BoardTenant & { project: string }): Promise<{ claims: HostedBoardClaim[] }>
  releaseBoardTaskClaims(
    input: BoardTenant & { project: string; key: string },
  ): Promise<{ released: number }>
}

function boardTenant(recordUrl: string, identity: RecordIdentity): BoardTenant | null {
  if (!identity.activeSpaceId) return null
  return {
    url: recordUrl,
    userId: identity.user.id,
    spaceId: identity.activeSpaceId,
    spaceIds: identity.memberships.map((row) => String(row.space_id)),
  }
}

export function registerRecordBoardRoutes(
  app: Hono<ApiEnvironment>,
  deps: { recordUrl: string } & RecordBoardDeps,
  helpers: {
    noSpace(context: Context<ApiEnvironment>): Response
    writeError(context: Context<ApiEnvironment>, error: unknown): Response | Promise<Response>
  },
): void {
  const tenantOf = (context: Context<ApiEnvironment>) =>
    boardTenant(deps.recordUrl, context.get('identity'))
  const readJson = async (context: Context<ApiEnvironment>) => context.req.json().catch(() => null)
  const writeError = (context: Context<ApiEnvironment>, error: unknown) =>
    helpers.writeError(context, hostedBoardStoreRefusal(error) ?? error)

  app.put('/v1/board/messages', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const body = postSchema.safeParse(await readJson(context))
    if (!body.success) return context.json({ error: 'invalid board message' }, 400)
    try {
      return context.json(await deps.postBoardMessage({ ...tenant, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/board/messages/:id/replies', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    const body = replySchema.safeParse(await readJson(context))
    if (!id.success || !body.success) return context.json({ error: 'invalid board reply' }, 400)
    try {
      return context.json(
        await deps.replyBoardMessage({ ...tenant, ...body.data, rootId: id.data }),
      )
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/board/messages/:id/withdraw', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    const body = sessionBody.safeParse((await readJson(context)) ?? {})
    if (!id.success || !body.success) return context.json({ error: 'invalid board withdraw' }, 400)
    try {
      return context.json(await deps.withdrawBoardMessage({ ...tenant, id: id.data, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/board/messages/:id/accept', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    const body = acceptSchema.safeParse(await readJson(context))
    if (!id.success || !body.success) return context.json({ error: 'invalid board accept' }, 400)
    try {
      return context.json(await deps.acceptBoardAnswer({ ...tenant, id: id.data, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/board/messages/:id/filing-lease/complete', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    const body = filingCompleteSchema.safeParse(await readJson(context))
    if (!id.success || !body.success)
      return context.json({ error: 'invalid board filing lease complete' }, 400)
    try {
      return context.json(
        await deps.completeBoardFilingLease({ ...tenant, id: id.data, ...body.data }),
      )
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/board/messages/:id/filing-lease/fail', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    const body = filingFailSchema.safeParse(await readJson(context))
    if (!id.success || !body.success)
      return context.json({ error: 'invalid board filing lease fail' }, 400)
    try {
      return context.json(await deps.failBoardFilingLease({ ...tenant, id: id.data, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/board/messages/:id/filing-lease', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    const body = sessionBody.safeParse((await readJson(context)) ?? {})
    if (!id.success || !body.success)
      return context.json({ error: 'invalid board filing lease' }, 400)
    try {
      return context.json(await deps.takeBoardFilingLease({ ...tenant, id: id.data, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.get('/v1/board/threads/:id', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'board thread id must be a uuid' }, 400)
    try {
      return context.json(await deps.readBoardThread({ ...tenant, id: id.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.get('/v1/board/messages/:id/status', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'board message id must be a uuid' }, 400)
    try {
      return context.json(await deps.boardStatus({ ...tenant, id: id.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.put('/v1/board/receipts', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const body = receiptSchema.safeParse(await readJson(context))
    if (!body.success) return context.json({ error: 'invalid board receipt' }, 400)
    try {
      return context.json(await deps.putBoardReceipt({ ...tenant, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.get('/v1/board/changes', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const query = z
      .object({
        after: z.string().regex(/^\d+$/).default('0'),
        limit: z.coerce.number().int().min(1).max(BOARD_CHANGES_PAGE_LIMIT).optional(),
      })
      .safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid board changes query' }, 400)
    try {
      return context.json(await deps.listBoardChanges({ ...tenant, ...query.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.put('/v1/board/claims', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const body = takeClaimSchema.safeParse(await readJson(context))
    if (!body.success) return context.json({ error: 'invalid board claim take' }, 400)
    try {
      return context.json(await deps.takeBoardClaim({ ...tenant, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/board/claims/release-task', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const body = releaseTaskSchema.safeParse(await readJson(context))
    if (!body.success) return context.json({ error: 'invalid board claim release-task' }, 400)
    try {
      return context.json(await deps.releaseBoardTaskClaims({ ...tenant, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/board/claims/:id/renew', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    const body = holderBody.safeParse((await readJson(context)) ?? {})
    if (!id.success || !body.success)
      return context.json({ error: 'invalid board claim renew' }, 400)
    try {
      return context.json(await deps.renewBoardClaim({ ...tenant, id: id.data, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/board/claims/:id/release', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    const body = holderBody.safeParse((await readJson(context)) ?? {})
    if (!id.success || !body.success)
      return context.json({ error: 'invalid board claim release' }, 400)
    try {
      return context.json(await deps.releaseBoardClaim({ ...tenant, id: id.data, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.get('/v1/board/claims', async (context) => {
    const tenant = tenantOf(context)
    if (!tenant) return helpers.noSpace(context)
    const query = z.object({ project: z.string().min(1) }).safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid board claim list query' }, 400)
    try {
      return context.json(await deps.listBoardClaims({ ...tenant, ...query.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
}
