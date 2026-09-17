import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
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
import { selectSnapshot } from '../../snapshot-selection.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()
const uuid = z.string().uuid()
const limit = z.number().int().min(1).max(100).default(20)
const filter = z.string().min(1).optional()

function recordClient(ctx: Context) {
  const baseUrl = process.env.HUB_RECORD_API_URL
  if (!baseUrl) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'HUB_RECORD_API_URL is required',
    })
  }
  return createRecordClient({
    baseUrl,
    headers: { cookie: ctx.cookie, authorization: ctx.authorization },
  })
}

function recordDatabaseUrl() {
  const value = process.env.HUB_RECORD_DATABASE_URL
  if (!value)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'HUB_RECORD_DATABASE_URL is required',
    })
  return value
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

const machineInput = z.object({ machineId: z.string().uuid().optional() })
const workInput = z.object({
  hours: z.union([z.literal(24), z.literal(48), z.literal(168), z.literal(720)]),
  filters: z.object({
    agent: z.string().max(64),
    project: z.string().max(64),
    source: z.string().max(64),
  }),
})

function optionalSnapshot<T extends { machineId: string; takenAt: string }>(
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
      message: `${refusal}\ncleared by: correct the named field and run orch record publish`,
    })
  return null
}

export const recordRouter = t.router({
  whoami: t.procedure.query(({ ctx }) => recordClient(ctx).whoami()),
  setActiveSpace: t.procedure
    .input(z.object({ spaceId: uuid }))
    .mutation(({ ctx, input }) => recordClient(ctx).setActiveSpace(input.spaceId)),
  runs: t.procedure
    .input(
      z.object({
        limit,
        cursor: z.string().optional(),
        project: filter,
        agent: filter,
        job: filter,
        status: filter,
      }),
    )
    .query(({ ctx, input }) => recordClient(ctx).runs(input)),
  run: t.procedure
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) => recordClient(ctx).run(input.id)),
  reviews: t.procedure
    .input(z.object({ limit, cursor: z.string().optional() }))
    .query(({ ctx, input }) => recordClient(ctx).reviews(input)),
  review: t.procedure
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) => recordClient(ctx).review(input.id)),
  projects: t.procedure.query(({ ctx }) => recordClient(ctx).projects()),
  snapshots: t.procedure.query(({ ctx }) => recordClient(ctx).snapshots()),
  docs: t.procedure
    .input(
      z.object({
        scope: filter,
        subject: filter,
        limit,
        cursor: z.string().optional(),
      }),
    )
    .query(({ ctx, input }) => recordClient(ctx).docs(input)),
  doc: t.procedure
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) => recordClient(ctx).doc(input.id)),
  docRevisions: t.procedure
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) => recordClient(ctx).docRevisions(input.id)),
  flight: t.procedure.input(workInput).query(async ({ ctx, input }) => {
    const { client, identity } = await hostedIdentity(ctx)
    return hostedFlightDone(recordDatabaseUrl(), identity, {
      ...input,
      name: 'flight',
      projects: await client.projects(),
    })
  }),
  done: t.procedure.input(workInput).query(async ({ ctx, input }) => {
    const { client, identity } = await hostedIdentity(ctx)
    return hostedFlightDone(recordDatabaseUrl(), identity, {
      ...input,
      name: 'done',
      projects: await client.projects(),
    })
  }),
  board: t.procedure.input(workInput).query(async ({ ctx, input }) => {
    const { client, identity } = await hostedIdentity(ctx)
    return hostedBoard(recordDatabaseUrl(), identity, {
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
      return hostedNotes(recordDatabaseUrl(), identity, input)
    }),
  ratio: t.procedure.input(workInput).query(async ({ ctx, input }) => {
    const { client, identity } = await hostedIdentity(ctx)
    const projects = await client.projects()
    const chrome = await hostedFlightDone(recordDatabaseUrl(), identity, {
      ...input,
      name: 'flight',
      projects,
    })
    const summary = await hostedRatio(recordDatabaseUrl(), identity)
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
  spend: t.procedure.input(workInput).query(async ({ ctx, input }) => {
    const { client, identity } = await hostedIdentity(ctx)
    const projects = await client.projects()
    const chrome = await hostedFlightDone(recordDatabaseUrl(), identity, {
      ...input,
      name: 'flight',
      projects,
    })
    return {
      ...chrome,
      view: 'spend' as const,
      data: await hostedSpend(recordDatabaseUrl(), identity),
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
        recordDatabaseUrl(),
        identity,
        projects.map((project) => project.name),
      )
    }),
  task: t.procedure
    .input(z.object({ key: z.string().min(1).max(64), spaceId: uuid.optional() }))
    .query(async ({ ctx, input }) => {
      const { identity } = await hostedIdentity(ctx)
      const detail = await hostedTaskDetail(
        recordDatabaseUrl(),
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
