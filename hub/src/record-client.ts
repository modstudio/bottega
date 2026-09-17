import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  HarnessHealthSchema,
  OrchAgentDefinitionSchema,
  OrchBlockersSchema,
  OrchStateSchema,
} from '../../shared/orch-contract.ts'

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
    delivery: z.string(),
    quality: z.string().nullable(),
    fidelity: z.string().nullable(),
    scoredAt: z.string(),
    note: z.string().nullable().optional(),
    scoredBy: z.string().optional(),
    runId: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .nullable()

const runSchema = z.object({
  id: z.string().uuid(),
  projectName: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  agent: z.string(),
  job: z.string(),
  status: z.string(),
  latencyMs: z.number().nullable(),
  promptHead: z.string(),
  failureKind: z.string().nullable(),
  vendorTokens: z.number().nullable(),
  vendorCostUsd: z.number().nullable(),
  label: z.string().nullable(),
  lens: z.string().nullable(),
  parentRunId: z.string().nullable(),
  turn: z.number(),
  evidenceExcluded: z.string().nullable(),
  score: scoreSchema,
})

const runListSchema = z.object({
  items: z.array(runSchema),
  nextCursor: z.string().nullable(),
})

const runDetailSchema = runSchema.passthrough().extend({
  reviews: z.array(z.unknown()),
})

const whoamiSchema = z.object({
  user: z.object({ id: z.string() }).passthrough(),
  activeSpaceId: z.string().nullable(),
  memberships: z.array(z.record(z.string(), z.unknown())),
})

const projectSchema = z.object({
  name: z.string(),
  keyPrefixes: z.array(z.string()),
  stack: z.string().nullable(),
  landingBranch: z.string().nullable(),
  color: z.string().nullable(),
  colorDark: z.string().nullable(),
  retiredAt: z.string().nullable(),
})

const reviewListItemSchema = z
  .object({
    id: z.string().uuid(),
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

type RecordRunListInput = {
  limit?: number
  cursor?: string
  project?: string
  agent?: string
  job?: string
  status?: string
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

const docSchema = z.object({
  id: z.string().uuid(),
  scope: z.string(),
  subject: z.string().nullable(),
  slug: z.string(),
  title: z.string(),
  body: z.string(),
  delivery: z.enum(['inject', 'demand']),
  projectName: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  deletedAt: z.string().datetime({ offset: true }).nullable(),
})

const docsSchema = z.object({ items: z.array(docSchema), nextCursor: z.string().nullable() })

const docRevisionSchema = z.object({
  id: z.string().uuid(),
  docId: z.string().uuid(),
  scope: z.string(),
  subject: z.string().nullable(),
  slug: z.string(),
  op: z.enum(['create', 'set', 'consume', 'delete', 'restore', 'import', 'backfill']),
  title: z.string(),
  body: z.string(),
  delivery: z.enum(['inject', 'demand']),
  author: z.string(),
  reason: z.string(),
  sessionId: z.string().nullable(),
  at: z.string().datetime({ offset: true }),
})

const docRevisionsSchema = z.object({ items: z.array(docRevisionSchema) })

type RecordDocListInput = {
  scope?: string
  subject?: string
  limit?: number
  cursor?: string
}

function mappedError(status: number, body: unknown): TRPCError {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const error = typeof record.error === 'string' ? record.error : `record API ${status}`
  const remedy = typeof record.remedy === 'string' ? record.remedy : undefined
  if (status === 401) return new TRPCError({ code: 'UNAUTHORIZED', message: remedy ?? error })
  if (status === 409) return new TRPCError({ code: 'PRECONDITION_FAILED', message: error })
  if (status === 404) return new TRPCError({ code: 'NOT_FOUND', message: error })
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
): Promise<T> {
  const headers = new Headers()
  if (options.headers.cookie) headers.set('Cookie', options.headers.cookie)
  if (options.headers.authorization) headers.set('Authorization', options.headers.authorization)
  const url = `${options.baseUrl.replace(/\/$/, '')}${path}`
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl(url, { headers })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw mappedError(response.status, body)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'record API returned an invalid body',
    })
  }
  return parsed.data
}

export function createRecordClient(options: RecordClientOptions) {
  return {
    whoami: () => request(options, '/v1/whoami', whoamiSchema),
    runs: (input: RecordRunListInput = {}) =>
      request(
        options,
        query('/v1/runs', {
          limit: input.limit,
          before: input.cursor,
          project: input.project,
          agent: input.agent,
          job: input.job,
          status: input.status,
        }),
        runListSchema,
      ),
    run: (id: string) => request(options, `/v1/runs/${id}`, runDetailSchema),
    reviews: (input: RecordReviewListInput = {}) =>
      request(
        options,
        query('/v1/reviews', { limit: input.limit, before: input.cursor }),
        reviewListSchema,
      ),
    review: (id: string) => request(options, `/v1/reviews/${id}`, reviewDetailSchema),
    projects: () => request(options, '/v1/projects', z.array(projectSchema)),
    snapshots: () => request(options, '/v1/snapshots', snapshotsSchema),
    docs: (input: RecordDocListInput = {}) =>
      request(
        options,
        query('/v1/docs', {
          scope: input.scope,
          subject: input.subject,
          limit: input.limit,
          cursor: input.cursor,
        }),
        docsSchema,
      ),
    doc: (id: string) => request(options, `/v1/docs/${encodeURIComponent(id)}`, docSchema),
    docRevisions: (id: string) =>
      request(options, `/v1/docs/${encodeURIComponent(id)}/revisions`, docRevisionsSchema),
  }
}
