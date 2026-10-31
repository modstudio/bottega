import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'
import {
  DOC_AUDIENCES,
  DOC_FORMS,
  DOC_KINDS,
  DOC_STATUSES,
  normalizeDocAudiences,
  normalizeDocSourceFiles,
  normalizeDocSummary,
} from '../../../../shared/docs.ts'
import type { MachineRef } from '../../../../shared/machine-label.ts'
import { parseRecordSpaceMemberships } from '../../../../shared/record-space-membership.ts'
import { recordSpaceAccessDecision } from '../../../../shared/record-space-request.ts'
import { hostedMeasurePeople, hostedMeasures } from '../../hosted-measures.ts'
import { hostedProjectReleases } from '../../hosted-releases.ts'
import {
  createHostedReportSubscription,
  unsubscribeHostedReportSubscription,
  updateHostedReportSubscription,
} from '../../hosted-reports.ts'
import {
  hostedBoard,
  hostedFlightDone,
  hostedNotes,
  hostedRatio,
  hostedSettings,
  hostedSpend,
  hostedTaskDetail,
} from '../../hosted-work.ts'
import { routingViewData } from '../../orch-transforms.ts'
import { createRecordClient } from '../../record-client.ts'
import { sendHostedReportSubscriptionTest } from '../../report-delivery-hosted.ts'
import { duration, liveRowDisplay, runRowDisplay } from '../../run-display.ts'
import { runListInput } from '../../run-list-input.ts'
import { selectSnapshot } from '../../snapshot-selection.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()
const uuid = z.string().uuid()
const email = z.string().trim().toLowerCase().email()
const limit = z.number().int().min(1).max(100).default(20)
const filter = z.string().min(1).optional()
const delivery = z.enum(['none', 'partial', 'full'])
const quality = z.enum(['wrong', 'mixed', 'right'])
const fidelity = z.enum(['drifted', 'partial', 'faithful'])
const HOSTED_STARTED_AT = new Date().toISOString()
const docAudiences = z
  .array(z.enum(DOC_AUDIENCES))
  .nonempty()
  .refine(
    (values) => new Set(values).size === values.length,
    'Audiences must not contain duplicates',
  )
  .transform(normalizeDocAudiences)

export function recordClient(ctx: Context) {
  const baseUrl = process.env.BOTTEGA_RECORD_API_URL
  if (!baseUrl) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'BOTTEGA_RECORD_API_URL is required',
    })
  }
  return createRecordClient({
    baseUrl,
    headers: { cookie: ctx.cookie, authorization: ctx.authorization },
  })
}

function recordDatabase(ctx: Context) {
  if (!ctx.recordDatabase)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'BOTTEGA_RECORD_DATABASE_URL is required',
    })
  return ctx.recordDatabase
}

async function hostedIdentity(ctx: Context) {
  const client = recordClient(ctx)
  const who = await client.whoami()
  if (!who.activeSpaceId)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'record session has no active space',
    })
  const membershipSpaceIds = who.memberships.map((row) => String(row.space_id))
  return {
    client,
    identity: {
      userId: who.user.id,
      spaceId: who.activeSpaceId,
      spaceIds:
        who.activeSpaceId === who.personalSpaceId ? membershipSpaceIds : [who.activeSpaceId],
    },
  }
}

async function hostedWriteIdentity(ctx: Context) {
  const client = recordClient(ctx)
  const who = await client.whoami()
  if (!who.activeSpaceId)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'record session has no active space',
    })
  const memberships = parseRecordSpaceMemberships(who.memberships)
  const access = recordSpaceAccessDecision('write', who.activeSpaceId, memberships)
  if (!access.allowed)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `${access.error}\n${access.remedy}`,
    })
  const membershipSpaceIds = memberships.map((membership) => membership.spaceId)
  return {
    identity: {
      userId: who.user.id,
      spaceId: who.activeSpaceId,
      spaceIds:
        who.activeSpaceId === who.personalSpaceId ? membershipSpaceIds : [who.activeSpaceId],
    },
  }
}

const machineInput = z.object({ machineId: z.string().uuid().optional() })
const workInput = z.object({
  hours: z.union([z.literal(24), z.literal(48), z.literal(168), z.literal(720)]),
  filters: z.object({
    agent: z.string().max(64),
    project: z.string().max(64),
    source: z.string().max(64),
  }),
})
const subscriptionCadenceInput = z
  .object({
    cadence: z.enum(['daily', 'weekly']),
    hour: z.number().int().min(0).max(23),
    weekday: z
      .enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])
      .nullable()
      .optional(),
    zone: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict()
const subscriptionScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('space') }).strict(),
  z
    .object({
      kind: z.literal('project'),
      project: z.string().min(1).max(64),
      projectId: uuid,
    })
    .strict(),
  z.object({ kind: z.literal('members'), userIds: z.array(uuid).min(1) }).strict(),
  z.object({ kind: z.literal('projects'), projectIds: z.array(uuid).min(1) }).strict(),
])

function optionalSnapshot<T extends { machineId: string; takenAt: string; machine: MachineRef }>(
  items: T[],
  ignored: string[],
  kind: string,
  machineId?: string,
) {
  const selection = selectSnapshot(items, machineId)
  if (selection) return selection
  const refusal = ignored.find((message) => message.startsWith(`${kind} snapshot ignored:`))
  if (refusal)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `${refusal}\ncleared by: correct the named field and run ${PLATFORM_SLUG} record publish`,
    })
  return null
}

export const recordRouter = t.router({
  whoami: t.procedure.query(({ ctx }) => recordClient(ctx).whoami()),
  setActiveSpace: t.procedure
    .input(z.object({ spaceId: uuid }))
    .mutation(({ ctx, input }) => recordClient(ctx).setActiveSpace(input.spaceId)),
  runsView: t.procedure.input(runListInput).query(async ({ ctx, input }) => {
    const now = Date.now()
    const window = await recordClient(ctx).runsView(input)
    const rows = window.items.map((run) => {
      const row = {
        id: run.id,
        machineLabel: run.machineLabel,
        space: run.spaceName,
        agent: run.agent,
        job: run.job,
        task: run.taskKey,
        project: run.projectName,
        at: run.startedAt,
        engaged: run.latencyMs === null ? '-' : duration(run.latencyMs),
        running: run.status === 'running',
        status: run.status,
        delivery: run.score?.delivery ?? null,
        quality: run.score?.quality ?? null,
        tokens: run.vendorTokens,
        costUsd: run.vendorCostUsd,
        probe: run.probe,
        lens: run.lens,
        evidence_excluded: run.evidenceExcluded,
      }
      return { ...row, display: runRowDisplay(row, now) }
    })
    const live = window.live.map((run) => {
      const row = {
        id: run.id,
        machineLabel: run.machineLabel,
        space: run.spaceName,
        agent: run.agent,
        job: run.job,
        repo: run.projectName,
        elapsedMs: Math.max(0, now - new Date(run.startedAt).getTime()),
        prompt_head: run.promptHead,
      }
      return { ...row, display: liveRowDisplay(row) }
    })
    return {
      collectedAt: null,
      servingSince: HOSTED_STARTED_AT,
      activeAgents: [...new Set(live.map((run) => run.agent))],
      view: 'runs' as const,
      data: {
        totals: { ...window.totals, stale_n: 0 },
        vendors: window.vendors,
        unscored: window.unscored,
        facets: window.facets,
        matched: window.matched,
        offset: window.offset,
        limit: window.limit,
        live,
        rows,
      },
    }
  }),
  run: t.procedure.input(z.object({ id: uuid })).query(async ({ ctx, input }) => {
    const client = recordClient(ctx)
    const [run, snapshots] = await Promise.all([client.run(input.id), client.snapshots()])
    const jobs = snapshots.items
      .filter((item) => item.kind === 'jobs' && item.machineId === run.machineId)
      .sort((left, right) => right.takenAt.localeCompare(left.takenAt))[0]
    const writesRepo =
      jobs?.kind === 'jobs'
        ? jobs.payload.find((job) => job.name === run.job)?.needs.writesRepo
        : false
    return {
      id: run.id,
      machineLabel: run.machineLabel,
      agent: run.agent,
      job: run.job,
      project: run.projectName,
      latency_ms: run.latencyMs,
      vendor_tokens: run.vendorTokens,
      status: run.status,
      failure_kind: run.failureKind,
      probe: run.probe,
      evidence_excluded: run.evidenceExcluded,
      error: run.error,
      prompt: run.promptHead,
      promptBytes: run.promptBytes,
      output: null,
      delivery: run.score?.delivery ?? null,
      quality: run.score?.quality ?? null,
      fidelity: run.score?.fidelity ?? null,
      note: run.score?.note ?? null,
      scored_at: run.score?.scoredAt ?? null,
      scoreAxes: writesRepo ? ['delivery', 'quality', 'fidelity'] : ['delivery', 'quality'],
      reviews: run.reviews,
    }
  }),
  score: t.procedure
    .input(
      z.object({
        id: uuid,
        delivery,
        quality: quality.nullable(),
        fidelity: fidelity.nullable(),
        note: z.string().nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      recordClient(ctx).score(input.id, {
        delivery: input.delivery,
        quality: input.quality,
        fidelity: input.fidelity,
        note: input.note,
        scoredAt: new Date().toISOString(),
      }),
    ),
  void: t.procedure
    .input(z.object({ id: uuid, reason: z.string().min(1) }))
    .mutation(({ ctx, input }) => recordClient(ctx).void(input.id, { reason: input.reason })),
  reviews: t.procedure
    .input(z.object({ limit, cursor: z.string().optional() }))
    .query(({ ctx, input }) => recordClient(ctx).reviews(input)),
  review: t.procedure
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) => recordClient(ctx).review(input.id)),
  projectReleases: t.procedure
    .input(z.object({ projectId: uuid, limit, cursor: z.string().optional() }))
    .query(({ ctx, input }) => hostedProjectReleases(recordClient(ctx), input)),
  projects: t.procedure.query(({ ctx }) => recordClient(ctx).projects()),
  snapshots: t.procedure.query(({ ctx }) => recordClient(ctx).snapshots()),
  docs: t.procedure
    .input(
      z.object({
        scope: filter,
        subject: filter,
        audience: z.enum(DOC_AUDIENCES).optional(),
        status: z.enum(DOC_STATUSES).optional(),
        kind: z.enum(DOC_KINDS).optional(),
        limit,
        cursor: z.string().optional(),
        acrossReadableSpaces: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => recordClient(ctx).docs(input)),
  doc: t.procedure
    .input(z.object({ id: uuid, audience: z.enum(DOC_AUDIENCES).optional() }))
    .query(({ ctx, input }) => recordClient(ctx).doc(input.id, input.audience)),
  docSearch: t.procedure
    .input(
      z.object({
        query: z.string(),
        scope: filter,
        subject: filter,
        audience: z.enum(DOC_AUDIENCES).optional(),
        includeDrafts: z.boolean().optional(),
        includeWorking: z.boolean().optional(),
        acrossReadableSpaces: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => recordClient(ctx).docSearch(input)),
  docRevisions: t.procedure
    .input(z.object({ id: uuid, audience: z.enum(DOC_AUDIENCES).optional() }))
    .query(({ ctx, input }) => recordClient(ctx).docRevisions(input.id, input.audience)),
  subjects: t.procedure
    .input(
      z.object({
        spaceId: uuid,
        project: z.string().trim().min(1),
        includeRetired: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => {
      const { spaceId, ...query } = input
      return recordClient(ctx).subjects(query, spaceId)
    }),
  saveDoc: t.procedure
    .input(
      z.object({
        spaceId: uuid,
        scope: z.string().min(1),
        subject: z.string().nullable(),
        slug: z.string().min(1),
        title: z.string(),
        body: z.string(),
        delivery: z.enum(['inject', 'demand']).optional(),
        status: z.enum(DOC_STATUSES).optional(),
        parentRecordId: uuid.nullable().optional(),
        audiences: docAudiences.optional(),
        form: z.enum(DOC_FORMS).nullable().optional(),
        articleSubjectId: uuid.nullable().optional(),
        relatedSubjectIds: z.array(uuid).optional(),
        sourceFiles: z.array(z.string()).transform(normalizeDocSourceFiles).optional(),
        summary: z.string().transform(normalizeDocSummary).nullable().optional(),
        reason: z.string().trim().min(1, 'Reason is required'),
        expectedRevision: uuid,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = recordClient(ctx)
      const who = await client.whoami()
      const { spaceId, ...doc } = input
      const saved = await client.putDoc(
        {
          ...doc,
          author: who.user.id,
        },
        spaceId,
      )
      return { revision: saved.revisionId }
    }),
  reorderDocs: t.procedure
    .input(
      z.object({
        spaceId: uuid,
        scope: z.string().min(1),
        subject: z.string().nullable(),
        parentId: uuid.nullable(),
        orderedIds: z.array(uuid),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { spaceId, ...order } = input
      return recordClient(ctx).reorderDocs(order, spaceId)
    }),
  deleteDoc: t.procedure
    .input(
      z.object({
        id: uuid,
        spaceId: uuid,
        reason: z.string().trim().min(1, 'Reason is required'),
        expectedRevision: uuid,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = recordClient(ctx)
      const who = await client.whoami()
      return client.deleteDoc(
        input.id,
        { reason: input.reason, expectedRevision: input.expectedRevision, author: who.user.id },
        input.spaceId,
      )
    }),
  flight: t.procedure.input(workInput).query(async ({ ctx, input }) => {
    const { client, identity } = await hostedIdentity(ctx)
    return hostedFlightDone(recordDatabase(ctx), identity, {
      ...input,
      name: 'flight',
      projects: await client.projects(),
    })
  }),
  done: t.procedure.input(workInput).query(async ({ ctx, input }) => {
    const { client, identity } = await hostedIdentity(ctx)
    return hostedFlightDone(recordDatabase(ctx), identity, {
      ...input,
      name: 'done',
      projects: await client.projects(),
    })
  }),
  board: t.procedure.input(workInput).query(async ({ ctx, input }) => {
    const { client, identity } = await hostedIdentity(ctx)
    return hostedBoard(recordDatabase(ctx), identity, {
      ...input,
      projects: await client.projects(),
    })
  }),
  notes: t.procedure
    .input(
      z.object({
        project: z.string().trim().min(1).max(64).optional(),
        stale: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { identity } = await hostedIdentity(ctx)
      return hostedNotes(recordDatabase(ctx), identity, input)
    }),
  ratio: t.procedure.input(workInput).query(async ({ ctx, input }) => {
    const { client, identity } = await hostedIdentity(ctx)
    const projects = await client.projects()
    const chrome = await hostedFlightDone(recordDatabase(ctx), identity, {
      ...input,
      name: 'flight',
      projects,
    })
    const summary = await hostedRatio(recordDatabase(ctx), identity)
    return {
      ...chrome,
      view: 'ratio' as const,
      data: {
        ...summary,
        days: summary.days.map((day) => ({
          day: day.day,
          ratio: day.ratio,
          tokens: day.claude_tokens,
          tasks: day.tasks,
          excluded: day.excluded,
        })),
      },
    }
  }),
  measures: t.procedure
    .input(
      z.object({
        from: z.iso.datetime(),
        to: z.iso.datetime(),
        scope: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('space') }),
          z.object({ kind: z.literal('project'), project: z.string().min(1).max(64) }),
          z.object({
            kind: z.literal('person'),
            userId: uuid,
            project: z.string().min(1).max(64).optional(),
          }),
        ]),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { identity } = await hostedIdentity(ctx)
      return hostedMeasures(
        recordDatabase(ctx),
        identity,
        { from: input.from, to: input.to },
        input.scope,
      )
    }),
  measurePeople: t.procedure
    .input(
      z.object({
        from: z.iso.datetime(),
        to: z.iso.datetime(),
        project: z.string().min(1).max(64).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { identity } = await hostedIdentity(ctx)
      return hostedMeasurePeople(
        recordDatabase(ctx),
        identity,
        { from: input.from, to: input.to },
        input.project,
      )
    }),
  spend: t.procedure.input(workInput).query(async ({ ctx, input }) => {
    const { client, identity } = await hostedIdentity(ctx)
    const projects = await client.projects()
    const chrome = await hostedFlightDone(recordDatabase(ctx), identity, {
      ...input,
      name: 'flight',
      projects,
    })
    return {
      ...chrome,
      view: 'spend' as const,
      data: await hostedSpend(recordDatabase(ctx), identity),
    }
  }),
  settings: t.procedure
    .input(
      z.object({ hours: z.union([z.literal(24), z.literal(48), z.literal(168), z.literal(720)]) }),
    )
    .query(async ({ ctx }) => {
      const { client, identity } = await hostedIdentity(ctx)
      const projects = await client.projects()
      return hostedSettings(
        recordDatabase(ctx),
        identity,
        projects.map((project) => project.name),
      )
    }),
  createReportSubscription: t.procedure
    .input(
      subscriptionCadenceInput.extend({
        scope: subscriptionScope,
        recipientUserIds: z.array(uuid),
        recipientEmails: z.array(email),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { identity } = await hostedWriteIdentity(ctx)
      return createHostedReportSubscription(recordDatabase(ctx), identity, input)
    }),
  updateReportSubscription: t.procedure
    .input(
      subscriptionCadenceInput.extend({
        id: uuid,
        scope: subscriptionScope,
        recipientUserIds: z.array(uuid),
        recipientEmails: z.array(email),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { identity } = await hostedWriteIdentity(ctx)
      const { id, ...update } = input
      return updateHostedReportSubscription(recordDatabase(ctx), identity, id, update)
    }),
  removeReportSubscription: t.procedure
    .input(z.object({ id: uuid }).strict())
    .mutation(async ({ ctx, input }) => {
      const { identity } = await hostedWriteIdentity(ctx)
      return unsubscribeHostedReportSubscription(recordDatabase(ctx), identity, input.id)
    }),
  sendReportSubscriptionTest: t.procedure
    .input(z.object({ id: uuid }).strict())
    .mutation(async ({ ctx, input }) => {
      const { identity } = await hostedWriteIdentity(ctx)
      return sendHostedReportSubscriptionTest(recordDatabase(ctx), identity, input.id)
    }),
  task: t.procedure
    .input(z.object({ key: z.string().min(1).max(64), spaceId: uuid.optional() }))
    .query(async ({ ctx, input }) => {
      const { identity } = await hostedIdentity(ctx)
      const detail = await hostedTaskDetail(
        recordDatabase(ctx),
        identity,
        input.key,
        input.spaceId ?? identity.spaceId,
      )
      if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: `no task ${input.key}` })
      return detail
    }),
  routing: t.procedure.input(machineInput).query(async ({ ctx, input }) => {
    const snapshots = await recordClient(ctx).snapshots()
    const states = snapshots.items.filter((item) => item.kind === 'state')
    const selection = optionalSnapshot(states, snapshots.ignored, 'state', input.machineId)
    if (!selection) return null
    const { selected, machines } = selection
    const blockers = snapshots.items
      .filter((item) => item.kind === 'blockers')
      .find((item) => item.machineId === selected.machineId)
    return {
      machineId: selected.machineId,
      takenAt: selected.takenAt,
      blockerTakenAt: blockers?.takenAt ?? null,
      machines,
      data: routingViewData(selected.payload, blockers?.payload ?? null),
    }
  }),
  health: t.procedure.input(machineInput).query(async ({ ctx, input }) => {
    const snapshots = await recordClient(ctx).snapshots()
    const selection = optionalSnapshot(
      snapshots.items.filter((item) => item.kind === 'health'),
      snapshots.ignored,
      'health',
      input.machineId,
    )
    if (!selection) return null
    const { selected, machines } = selection
    return {
      machineId: selected.machineId,
      takenAt: selected.takenAt,
      machines,
      data: selected.payload,
    }
  }),
  jobs: t.procedure.input(machineInput).query(async ({ ctx, input }) => {
    const snapshots = await recordClient(ctx).snapshots()
    const selection = optionalSnapshot(
      snapshots.items.filter((item) => item.kind === 'jobs'),
      snapshots.ignored,
      'jobs',
      input.machineId,
    )
    if (!selection) return null
    const { selected, machines } = selection
    return {
      machineId: selected.machineId,
      takenAt: selected.takenAt,
      machines,
      data: selected.payload,
    }
  }),
  agents: t.procedure.input(machineInput).query(async ({ ctx, input }) => {
    const snapshots = await recordClient(ctx).snapshots()
    const selection = optionalSnapshot(
      snapshots.items.filter((item) => item.kind === 'agents'),
      snapshots.ignored,
      'agents',
      input.machineId,
    )
    if (!selection) return null
    const { selected, machines } = selection
    return {
      machineId: selected.machineId,
      takenAt: selected.takenAt,
      machines,
      data: selected.payload,
    }
  }),
})
