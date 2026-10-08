import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { DOC_AUDIENCES } from '../../shared/docs.ts'
import {
  HarnessHealthSchema,
  OrchAgentDefinitionSchema,
  OrchBlockersSchema,
  OrchStateSchema,
} from '../../shared/orch-contract.ts'
import {
  BoardListResultSchema,
  BoardStatusResultSchema,
  BoardThreadResultSchema,
} from './board-contract.ts'
import { DocSchema, DocSearchSchema, DocTreeItemSchema, DocTreeSchema } from './doc-contract.ts'

type RecordAuthHeaders = {
  cookie?: string
  authorization?: string
}

export type RecordFetch = (input: string, init?: RequestInit) => Promise<Response>

type RecordClientOptions = {
  baseUrl: string
  headers: RecordAuthHeaders
  fetch?: RecordFetch
}

const scoreSchema = z
  .object({
    delivery: z.enum(['none', 'partial', 'full']),
    quality: z.enum(['wrong', 'mixed', 'right']).nullable(),
    fidelity: z.enum(['drifted', 'partial', 'faithful']).nullable(),
    scoredAt: z.string(),
    note: z.string().nullable().optional(),
    scoredBy: z.string().optional(),
    runId: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .nullable()

const scoreInputSchema = z.object({
  delivery: z.enum(['none', 'partial', 'full']),
  quality: z.enum(['wrong', 'mixed', 'right']).nullable(),
  fidelity: z.enum(['drifted', 'partial', 'faithful']).nullable(),
  note: z.string().nullable(),
  scoredAt: z.string().datetime({ offset: true }),
})
const voidInputSchema = z.object({ reason: z.string().min(1) })
const verdictResponseSchema = z.object({ ok: z.literal(true) })

const runSchema = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  spaceName: z.string(),
  projectName: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  agent: z.string(),
  job: z.string(),
  status: z.string(),
  latencyMs: z.number().nullable(),
  promptHead: z.string(),
  taskKey: z.string().nullable(),
  failureKind: z.string().nullable(),
  vendorTokens: z.number().nullable(),
  vendorCostUsd: z.number().nullable(),
  label: z.string().nullable(),
  lens: z.string().nullable(),
  parentRunId: z.string().nullable(),
  turn: z.number(),
  evidenceExcluded: z.string().nullable(),
  probe: z.boolean(),
  score: scoreSchema,
})

const runWindowSchema = z.object({
  items: z.array(runSchema),
  matched: z.number(),
  offset: z.number(),
  limit: z.union([z.literal(25), z.literal(50), z.literal(100)]),
  facets: z.object({ agents: z.array(z.string()), projects: z.array(z.string()) }),
  totals: z.object({
    runs: z.number(),
    scored: z.number(),
    voided: z.number(),
    failed: z.number(),
  }),
  vendors: z.array(
    z.object({ agent: z.string(), tokens: z.number().nullable(), runs: z.number() }),
  ),
  unscored: z.number(),
  live: z.array(runSchema),
})

const runDetailSchema = runSchema.passthrough().extend({
  machineId: z.string().uuid(),
  promptBytes: z.number(),
  error: z.string().nullable(),
  reviews: z.array(z.unknown()),
})

const whoamiSchema = z.object({
  user: z.object({ id: z.string() }).passthrough(),
  activeSpaceId: z.string().nullable(),
  personalSpaceId: z.string().nullable(),
  memberships: z.array(z.record(z.string(), z.unknown())),
})

const projectSchema = z.object({
  spaceId: z.string().uuid(),
  spaceName: z.string(),
  name: z.string(),
  keyPrefixes: z.array(z.string()),
  stack: z.string().nullable(),
  managedContext: z.boolean(),
  landingBranch: z.string().nullable(),
  color: z.string().nullable(),
  colorDark: z.string().nullable(),
  retiredAt: z.string().nullable(),
})

const reviewListItemSchema = z
  .object({
    id: z.string().uuid(),
    spaceId: z.string().uuid(),
    spaceName: z.string(),
    recordedAt: z.string(),
    projectName: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
    tier: z.number().nullable().optional(),
    lensCount: z.number().optional(),
    findingCount: z.number().optional(),
  })
  .passthrough()

const reviewListSchema = z.object({
  items: z.array(reviewListItemSchema),
  nextCursor: z.string().nullable(),
})

const reviewDetailSchema = reviewListItemSchema.extend({
  lenses: z.array(z.unknown()),
})

type RecordRunWindowInput = {
  hours: 24 | 48 | 168 | 720
  agent: string
  project: string
  offset: number
  limit: 25 | 50 | 100
  search: string
}

type RecordReviewListInput = {
  limit?: number
  cursor?: string
}

const jobSchema = z.object({
  name: z.string(),
  what: z.string(),
  needs: z.record(z.string(), z.boolean()),
  prefer: z.array(z.string()),
  contextTokens: z.number(),
  timeoutMs: z.number().nullable(),
  findings: z.boolean(),
})

const snapshotBase = {
  id: z.string().uuid(),
  machineId: z.string().uuid(),
  takenAt: z.string().datetime({ offset: true }),
}

const snapshotSchema = z.discriminatedUnion('kind', [
  z.object({ ...snapshotBase, kind: z.literal('state'), payload: OrchStateSchema }),
  z.object({ ...snapshotBase, kind: z.literal('blockers'), payload: OrchBlockersSchema }),
  z.object({ ...snapshotBase, kind: z.literal('health'), payload: HarnessHealthSchema }),
  z.object({ ...snapshotBase, kind: z.literal('jobs'), payload: z.array(jobSchema) }),
  z.object({
    ...snapshotBase,
    kind: z.literal('agents'),
    payload: z.array(OrchAgentDefinitionSchema),
  }),
])

function snapshotKind(value: unknown) {
  if (!value || typeof value !== 'object') return 'unknown'
  const kind = (value as Record<string, unknown>).kind
  return typeof kind === 'string' ? kind : 'unknown'
}

function snapshotIssue(value: unknown, issue: z.core.$ZodIssue) {
  const path = issue.path.map(String).join('.') || '(root)'
  return `${snapshotKind(value)} snapshot ignored: ${path} ${issue.message}`
}

const snapshotsSchema = z.object({ items: z.array(z.unknown()) }).transform(({ items }) => {
  const accepted: z.infer<typeof snapshotSchema>[] = []
  const ignored: string[] = []
  for (const item of items) {
    const parsed = snapshotSchema.safeParse(item)
    if (parsed.success) accepted.push(parsed.data)
    else ignored.push(...parsed.error.issues.map((issue) => snapshotIssue(item, issue)))
  }
  return { items: accepted, ignored }
})

const docSchema = DocSchema.extend({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  spaceName: z.string(),
  scope: z.string(),
  subject: z.string().nullable(),
  owner: z.string().uuid().nullable(),
  delivery: z.enum(['inject', 'demand']),
  // A record that predates the tree fields omits them; such a document is a technical root.
  audience: z.enum(DOC_AUDIENCES).default('technical'),
  parentId: z.string().uuid().nullable().default(null),
  position: z.number().int().default(0),
  status: z.enum(['draft', 'current', 'superseded', 'archived']).default('current'),
  replacementSlug: z.string().nullable().default(null),
  summary: z.string().default(''),
  featured: z.boolean().default(false),
  projectName: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  deletedAt: z.string().datetime({ offset: true }).nullable(),
})

const docsSchema = z.object({ items: z.array(docSchema), nextCursor: z.string().nullable() })

const publicDocTreeItemSchema = DocTreeItemSchema.omit({ audience: true }).transform((doc) => ({
  ...doc,
  summary: doc.summary ?? '',
  featured: doc.featured ?? false,
  // The record public role's policy admits only user-audience documents.
  audience: 'user' as const,
}))
const publicDocSchema = publicDocTreeItemSchema
  .and(z.object({ body: z.string() }))
  .transform((doc) => DocSchema.parse(doc))
const publicDocsSchema = z
  .object({ items: z.array(publicDocTreeItemSchema) })
  .transform((value) => DocTreeSchema.parse(value))

const docRevisionSchema = z.object({
  id: z.string().uuid(),
  docId: z.string().uuid(),
  scope: z.string(),
  subject: z.string().nullable(),
  owner: z.string().uuid().nullable(),
  slug: z.string(),
  op: z.enum(['create', 'set', 'consume', 'delete', 'restore', 'import', 'backfill']),
  title: z.string(),
  body: z.string(),
  delivery: z.enum(['inject', 'demand']),
  audience: z.enum(DOC_AUDIENCES).default('technical'),
  parentId: z.string().uuid().nullable().default(null),
  position: z.number().int().default(0),
  status: z.enum(['draft', 'current', 'superseded', 'archived']).default('current'),
  replacementSlug: z.string().nullable().default(null),
  author: z.string(),
  reason: z.string(),
  sessionId: z.string().nullable(),
  at: z.string().datetime({ offset: true }),
})

const docRevisionsSchema = z.object({ items: z.array(docRevisionSchema) })

type RecordDocListInput = {
  scope?: string
  subject?: string
  audience?: 'user' | 'technical'
  status?: 'draft' | 'current' | 'superseded' | 'archived'
  limit?: number
  cursor?: string
  acrossReadableSpaces?: boolean
}

const docWriteResultSchema = z.object({ id: z.string().uuid(), revisionId: z.string().uuid() })
const deletedResultSchema = z.object({ id: z.string().uuid(), revisionId: z.string().uuid() })
const configEntrySchema = z.object({
  key: z.string(),
  environment: z.string(),
  scope: z.enum(['user', 'space']),
  value: z.string(),
  rowVersion: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
})
const settingsPermissionResultSchema = z.object({
  revision: z.string().uuid(),
  permissions: z.object({
    allow: z.array(z.string()),
    ask: z.array(z.string()),
    deny: z.array(z.string()),
  }),
})

const boardRootSchema = BoardThreadResultSchema.shape.root
const hostedBoardMessageSchema = boardRootSchema.omit({ text: true }).extend({
  kind: z.string(),
  body: z.string(),
  origin: boardRootSchema.shape.origin.unwrap(),
  senderTags: boardRootSchema.shape.senderTags.unwrap(),
  createdAt: z.string(),
  revision: z.string(),
  scopeProjectIds: z.array(z.string()),
  recipientUserIds: z.array(z.string()),
  authorUserId: z.string(),
  ackRequired: z.boolean(),
})
const hostedBoardThreadSchema = z.object({
  root: hostedBoardMessageSchema,
  replies: BoardThreadResultSchema.shape.replies,
})
const hostedBoardStatusSchema = z.object({
  message: hostedBoardMessageSchema,
  receipts: z.array(
    BoardStatusResultSchema.shape.receipts.element.extend({ readerUserId: z.string() }),
  ),
})
const hostedBoardListSchema = z.object({
  messages: BoardListResultSchema.shape.messages.refine(
    (messages) => messages.every((message) => message.store === 'hosted'),
    'hosted board messages must use the hosted store',
  ),
  truncated: z.boolean(),
})
const hostedBoardPostInputSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('notice'),
  audience: z.string(),
  title: z.string(),
  body: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
  ackRequired: z.boolean().optional(),
  ackDeadline: z.string().datetime({ offset: true }).nullable().optional(),
  task: z.string().optional(),
  paths: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  project: z.string().optional(),
})
const hostedBoardReplyInputSchema = z.object({ id: z.string().uuid(), body: z.string() })

export type RecordDoc = z.infer<typeof docSchema>
export type RecordConfigEntry = z.infer<typeof configEntrySchema>

function mappedError(status: number, body: unknown, path: string): TRPCError {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const error = typeof record.error === 'string' ? record.error : `record API ${status}`
  const remedy = typeof record.remedy === 'string' ? record.remedy : undefined
  if (status === 401) return new TRPCError({ code: 'UNAUTHORIZED', message: remedy ?? error })
  if (status === 403) return new TRPCError({ code: 'FORBIDDEN', message: error })
  if (status === 429) return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: error })
  if (status === 409) return new TRPCError({ code: 'CONFLICT', message: error })
  if (status === 404)
    return new TRPCError({
      code: 'NOT_FOUND',
      message:
        body === null && path.startsWith('/v1/board/')
          ? 'the hosted record does not serve the message board yet'
          : error,
    })
  if (status === 400) return new TRPCError({ code: 'BAD_REQUEST', message: error })
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error })
}

function query(path: string, params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `${path}?${encoded}` : path
}

async function request<T>(
  options: RecordClientOptions,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  if (options.headers.cookie) headers.set('Cookie', options.headers.cookie)
  if (options.headers.authorization) headers.set('Authorization', options.headers.authorization)
  const url = `${options.baseUrl.replace(/\/$/, '')}${path}`
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl(url, { ...init, headers })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw mappedError(response.status, body, path)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'record API returned an invalid body',
    })
  }
  return parsed.data
}

function publicRequest<T>(
  options: RecordClientOptions,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return request({ ...options, headers: {} }, path, schema)
}

export function createRecordClient(options: RecordClientOptions) {
  return {
    publicDocs: () => publicRequest(options, '/public/v1/docs', publicDocsSchema),
    publicDoc: (id: string) =>
      publicRequest(options, `/public/v1/docs/${encodeURIComponent(id)}`, publicDocSchema),
    publicDocSearch: (search: string) =>
      publicRequest(options, query('/public/v1/docs/search', { q: search }), DocSearchSchema),
    whoami: () => request(options, '/v1/whoami', whoamiSchema),
    setActiveSpace: (spaceId: string) =>
      request(options, '/v1/active-space', z.object({ activeSpaceId: z.string() }), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spaceId }),
      }),
    runsView: (input: RecordRunWindowInput) =>
      request(
        options,
        query('/v1/runs/window', {
          hours: input.hours,
          limit: input.limit,
          offset: input.offset,
          project: input.project,
          agent: input.agent,
          search: input.search,
        }),
        runWindowSchema,
      ),
    run: (id: string) => request(options, `/v1/runs/${id}`, runDetailSchema),
    score: (id: string, input: z.input<typeof scoreInputSchema>) =>
      request(options, `/v1/runs/${id}/score`, verdictResponseSchema, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(scoreInputSchema.parse(input)),
      }),
    void: (id: string, input: z.input<typeof voidInputSchema>) =>
      request(options, `/v1/runs/${id}/void`, verdictResponseSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(voidInputSchema.parse(input)),
      }),
    reviews: (input: RecordReviewListInput = {}) =>
      request(
        options,
        query('/v1/reviews', { limit: input.limit, before: input.cursor }),
        reviewListSchema,
      ),
    review: (id: string) => request(options, `/v1/reviews/${id}`, reviewDetailSchema),
    projects: () => request(options, '/v1/projects', z.array(projectSchema)),
    snapshots: () => request(options, '/v1/snapshots', snapshotsSchema),
    boardList: (input: { kind?: 'notice' | 'question'; open?: boolean; includeEnded?: boolean }) =>
      request(
        options,
        query('/v1/board/messages', {
          kind: input.kind,
          open: input.open ? 'true' : undefined,
          includeEnded: input.includeEnded ? 'true' : undefined,
        }),
        hostedBoardListSchema,
      ),
    boardThread: (id: string) =>
      request(options, `/v1/board/threads/${encodeURIComponent(id)}`, hostedBoardThreadSchema),
    boardStatus: (id: string) =>
      request(
        options,
        `/v1/board/messages/${encodeURIComponent(id)}/status`,
        hostedBoardStatusSchema,
      ),
    boardPost: (input: z.input<typeof hostedBoardPostInputSchema>) =>
      request(options, '/v1/board/messages', hostedBoardMessageSchema, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(hostedBoardPostInputSchema.parse(input)),
      }),
    boardReply: (rootId: string, input: z.input<typeof hostedBoardReplyInputSchema>) =>
      request(
        options,
        `/v1/board/messages/${encodeURIComponent(rootId)}/replies`,
        hostedBoardMessageSchema,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(hostedBoardReplyInputSchema.parse(input)),
        },
      ),
    boardAccept: (questionId: string, replyId: string) =>
      request(
        options,
        `/v1/board/messages/${encodeURIComponent(questionId)}/accept`,
        hostedBoardThreadSchema,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ replyId }),
        },
      ),
    boardWithdraw: (id: string) =>
      request(
        options,
        `/v1/board/messages/${encodeURIComponent(id)}/withdraw`,
        hostedBoardMessageSchema,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      ),
    docs: (input: RecordDocListInput = {}) =>
      request(
        options,
        query('/v1/docs', {
          scope: input.scope,
          subject: input.subject,
          audience: input.audience,
          status: input.status,
          limit: input.limit,
          cursor: input.cursor,
          acrossReadableSpaces: input.acrossReadableSpaces ? 'true' : undefined,
        }),
        docsSchema,
      ),
    doc: (id: string) => request(options, `/v1/docs/${encodeURIComponent(id)}`, docSchema),
    docSearch: (input: {
      query: string
      scope?: string
      subject?: string
      audience?: 'user' | 'technical'
      acrossReadableSpaces?: boolean
    }) =>
      request(
        options,
        query('/v1/docs/search', {
          q: input.query,
          scope: input.scope,
          subject: input.subject,
          audience: input.audience,
          acrossReadableSpaces: input.acrossReadableSpaces ? 'true' : undefined,
        }),
        DocSearchSchema,
      ),
    docRevisions: (id: string) =>
      request(options, `/v1/docs/${encodeURIComponent(id)}/revisions`, docRevisionsSchema),
    putDoc: (input: {
      scope: string
      subject: string | null
      owner?: string | null
      slug: string
      title: string
      body: string
      delivery: 'inject' | 'demand'
      reason: string
      author: string
      expectedRevision?: string
    }) =>
      request(options, '/v1/docs', docWriteResultSchema, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    deleteDoc: (id: string, input: { reason: string; author: string; expectedRevision?: string }) =>
      request(options, `/v1/docs/${encodeURIComponent(id)}`, deletedResultSchema, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    configEntries: () =>
      request(
        options,
        query('/v1/config/entries', { environment: 'default' }),
        z.object({ items: z.array(configEntrySchema) }),
      ).then(({ items }) => items),
    putConfigEntry: (
      key: string,
      input: {
        scope: 'user' | 'space'
        value: string
        expectedRowVersion: number | null
      },
    ) =>
      request(options, `/v1/config/entries/${encodeURIComponent(key)}`, configEntrySchema, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, environment: 'default' }),
      }),
    deleteConfigEntry: (
      key: string,
      input: { scope: 'user' | 'space'; expectedRowVersion: number },
    ) =>
      request(
        options,
        `/v1/config/entries/${encodeURIComponent(key)}`,
        z.object({ deleted: z.literal(true) }),
        {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...input, environment: 'default' }),
        },
      ),
    settingsPermission: (input: {
      target: { kind: 'user' } | { kind: 'project'; project: string }
      list: 'allow' | 'ask' | 'deny'
      rule: string
      operation: 'add' | 'remove'
      reason: string
      expectedRevision: string
    }) =>
      request(options, '/v1/settings/permission', settingsPermissionResultSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
  }
}

export type RecordClient = ReturnType<typeof createRecordClient>
