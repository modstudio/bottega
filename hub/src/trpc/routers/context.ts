import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
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
const autonomyValue = z.enum(['ask', 'review', 'auto'])
const target = z.union([
  z.object({ user: z.literal(true) }),
  z.object({ project: z.string().min(1) }),
])

function projectPath(name: string): string {
  const project = projects().find((row) => row.name === name)
  if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: `No project "${name}"` })
  return project.path
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
      .query(({ input }) => fromOrch(() => contextGet(projectPath(input.project)))),
    set: mutation
      .input(
        z.object({ project: z.string().min(1), stage: z.string().min(1), value: autonomyValue }),
      )
      .mutation(async ({ input }) => {
        const cwd = projectPath(input.project)
        const before = await fromOrch(() => contextGet(cwd))
        if (!before.registered || !before.stages.some(({ stage }) => stage === input.stage)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Unknown autonomy stage "${input.stage}"`,
          })
        }
        await fromOrch(() => configSet(`autonomy.stage.${input.stage}`, input.value))
        return fromOrch(() => contextGet(cwd))
      }),
  }),
  settings: t.router({
    get: t.procedure.input(target).query(({ input }) => fromOrch(() => settingsCheck(input))),
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
