import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
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

const machineInput = z.object({ machineId: z.string().uuid().optional() })

function requiredSnapshot<T extends { machineId: string; takenAt: string }>(
  items: T[],
  machineId?: string,
) {
  const selection = selectSnapshot(items, machineId)
  if (selection) return selection
  throw new TRPCError({ code: 'NOT_FOUND', message: 'No snapshot is available for this machine' })
}

export const recordRouter = t.router({
  whoami: t.procedure.query(({ ctx }) => recordClient(ctx).whoami()),
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
  routing: t.procedure.input(machineInput).query(async ({ ctx, input }) => {
    const snapshots = await recordClient(ctx).snapshots()
    const states = snapshots.items.filter((item) => item.kind === 'state')
    const { selected, machines } = requiredSnapshot(states, input.machineId)
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
    const { selected, machines } = requiredSnapshot(
      snapshots.items.filter((item) => item.kind === 'health'),
      input.machineId,
    )
    return {
      machineId: selected.machineId,
      takenAt: selected.takenAt,
      machines,
      data: selected.payload,
    }
  }),
  jobs: t.procedure.input(machineInput).query(async ({ ctx, input }) => {
    const snapshots = await recordClient(ctx).snapshots()
    const { selected, machines } = requiredSnapshot(
      snapshots.items.filter((item) => item.kind === 'jobs'),
      input.machineId,
    )
    return {
      machineId: selected.machineId,
      takenAt: selected.takenAt,
      machines,
      data: selected.payload,
    }
  }),
  agents: t.procedure.input(machineInput).query(async ({ ctx, input }) => {
    const snapshots = await recordClient(ctx).snapshots()
    const { selected, machines } = requiredSnapshot(
      snapshots.items.filter((item) => item.kind === 'agents'),
      input.machineId,
    )
    return {
      machineId: selected.machineId,
      takenAt: selected.takenAt,
      machines,
      data: selected.payload,
    }
  }),
})
