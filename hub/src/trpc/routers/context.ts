import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  AUTONOMY_PRESETS,
  AUTONOMY_STAGES,
  AUTONOMY_VALUES,
  type AutonomyPreset,
} from '../../../../shared/autonomy.ts'
import { RELEASE_AUTONOMY_VALUES } from '../../../../shared/release-autonomy.ts'
import {
  configDelete,
  configList,
  configSet,
  contextGet,
  dashboardMutationAvailable,
  settingsCheck,
  settingsPermission,
  userDocGet,
  userDocList,
  userDocRemove,
  userDocSet,
} from '../../orch.ts'
import { projects } from '../../projects.ts'
import type { Context } from '../context.ts'
import { fromOrch } from '../orch-error.ts'

const t = initTRPC.context<Context>().create()
const mutation = t.procedure.use(({ next }) => {
  if (!dashboardMutationAvailable()) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Dashboard mutation capability is unavailable',
    })
  }
  return next()
})
const revision = z.string().trim().min(1, 'Expected revision is required').optional()
const reason = z.string().trim().min(1, 'Reason is required')
const slug = z.string().trim().min(1, 'Slug is required')
const permissionList = z.enum(['allow', 'ask', 'deny'])
const autonomyValue = z.enum(AUTONOMY_VALUES)
const autonomyPreset = z.enum(AUTONOMY_PRESETS)
const releaseValue = z.enum(RELEASE_AUTONOMY_VALUES)
const target = z.union([
  z.object({ user: z.literal(true) }),
  z.object({ project: z.string().min(1) }),
])

function projectPath(name: string): string {
  const project = projects().find((row) => row.name === name)
  if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: `No project "${name}"` })
  return project.path
}

async function localAutonomy(project: string) {
  const cwd = projectPath(project)
  const [resolved, entries] = await Promise.all([
    fromOrch(() => contextGet(cwd)),
    fromOrch(configList),
  ])
  const user = entries.filter((entry) => entry.scope === 'user')
  const preset = user.find((entry) => entry.key === 'autonomy.preset')?.value
  const userPreset = AUTONOMY_PRESETS.includes(preset as AutonomyPreset)
    ? (preset as AutonomyPreset)
    : null
  if (!resolved.registered) return { ...resolved, userPreset }
  return {
    ...resolved,
    userPreset,
    stages: resolved.stages.map((stage) => ({
      ...stage,
      overridden: user.some((entry) => entry.key === `autonomy.stage.${stage.stage}`),
    })),
  }
}

export const contextRouter = t.router({
  projects: t.procedure.query(() =>
    projects().map(({ name, path, settings }) => ({
      name,
      path,
      managedContext: settings.managedContext === true,
      worktreeNote:
        typeof settings.worktree === 'object' &&
        settings.worktree !== null &&
        'notes' in settings.worktree &&
        typeof settings.worktree.notes === 'string'
          ? settings.worktree.notes
          : null,
    })),
  ),
  userCanon: t.router({
    list: t.procedure.query(() => fromOrch(userDocList)),
    get: t.procedure
      .input(z.object({ slug }))
      .query(({ input }) => fromOrch(() => userDocGet(input.slug))),
    set: mutation
      .input(
        z.object({
          slug,
          title: z.string().trim().min(1, 'Title is required'),
          body: z.string(),
          reason,
          expectedRevision: revision,
        }),
      )
      .mutation(({ input }) => fromOrch(() => userDocSet({ ...input, delivery: 'inject' }), true)),
    remove: mutation
      .input(z.object({ slug, reason, expectedRevision: revision }))
      .mutation(({ input }) =>
        fromOrch(() => userDocRemove(input.slug, input.reason, input.expectedRevision), true),
      ),
  }),
  autonomy: t.router({
    get: t.procedure
      .input(z.object({ project: z.string().min(1) }))
      .query(({ input }) => localAutonomy(input.project)),
    set: mutation
      .input(
        z.object({
          project: z.string().min(1),
          stage: z.string().min(1),
          value: autonomyValue,
          expectedRowVersion: z.number().int().positive().nullable().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const before = await localAutonomy(input.project)
        if (!before.registered || !before.stages.some(({ stage }) => stage === input.stage)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Unknown autonomy stage "${input.stage}"`,
          })
        }
        await fromOrch(() => configSet(`autonomy.stage.${input.stage}`, input.value))
        return localAutonomy(input.project)
      }),
    setRelease: mutation
      .input(
        z.object({
          project: z.string().min(1),
          value: releaseValue,
          expectedRowVersion: z.number().int().positive().nullable().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        projectPath(input.project)
        await fromOrch(() => configSet('autonomy.release', input.value))
        return localAutonomy(input.project)
      }),
    setPreset: mutation
      .input(
        z.object({
          project: z.string().min(1),
          value: autonomyPreset,
          expectedRowVersion: z.number().int().positive().nullable().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        projectPath(input.project)
        const entries = await fromOrch(configList)
        for (const stage of AUTONOMY_STAGES) {
          if (
            entries.some(
              (entry) => entry.scope === 'user' && entry.key === `autonomy.stage.${stage}`,
            )
          ) {
            await fromOrch(() => configDelete(`autonomy.stage.${stage}`))
          }
        }
        await fromOrch(() => configSet('autonomy.preset', input.value))
        return localAutonomy(input.project)
      }),
  }),
  settings: t.router({
    get: t.procedure.input(target).query(async ({ input }) => ({
      ...(await fromOrch(() => settingsCheck(input))),
      mode: 'local' as const,
    })),
    permission: mutation
      .input(
        z.object({
          target,
          list: permissionList,
          rule: z.string().trim().min(1, 'Rule is required'),
          operation: z.enum(['add', 'remove']),
          reason,
          expectedRevision: z.string().trim().min(1, 'Expected revision is required'),
        }),
      )
      .mutation(({ input }) => fromOrch(() => settingsPermission(input), true)),
  }),
})
