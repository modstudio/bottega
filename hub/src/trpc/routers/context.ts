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
  machineConfigDelete,
  machineConfigList,
  machineConfigSet,
  machinePermission,
  machinePermissions,
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
const rulingsValue = z.enum(['agent', 'user'])
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
  const [resolved, machineEntries] = await Promise.all([
    fromOrch(() => contextGet(cwd)),
    fromOrch(machineConfigList),
  ])
  let entries: Awaited<ReturnType<typeof configList>> = []
  let configWarning: string | null = null
  try {
    entries = await fromOrch(configList)
  } catch {
    configWarning =
      'warning: hosted autonomy preset and overrides are unavailable until you sign in'
  }
  const user = entries.filter((entry) => entry.scope === 'user')
  const preset = user.find((entry) => entry.key === 'autonomy.preset')?.value
  const userPreset = AUTONOMY_PRESETS.includes(preset as AutonomyPreset)
    ? (preset as AutonomyPreset)
    : configWarning
      ? undefined
      : null
  if (!resolved.registered) {
    return {
      ...resolved,
      userPreset,
      ...(configWarning ? { warnings: [...(resolved.warnings ?? []), configWarning] } : {}),
    } as typeof resolved & {
      userPreset?: AutonomyPreset | null
    }
  }
  const machineValue = (key: string) => machineEntries.find((entry) => entry.key === key)?.value
  const stages: Array<
    (typeof resolved.stages)[number] & { overridden?: boolean | null; machineValue?: string }
  > = resolved.stages.map((stage) => ({
    ...stage,
    ...(machineValue(`autonomy.stage.${stage.stage}`) !== undefined
      ? { machineValue: machineValue(`autonomy.stage.${stage.stage}`) }
      : {}),
    overridden: configWarning
      ? null
      : user.some((entry) => entry.key === `autonomy.stage.${stage.stage}`),
  }))
  return {
    ...resolved,
    rulings: {
      ...resolved.rulings,
      ...(machineValue('autonomy.rulings') !== undefined
        ? { machineValue: machineValue('autonomy.rulings') }
        : {}),
    },
    release: {
      ...resolved.release,
      ...(machineValue('autonomy.release') !== undefined
        ? { machineValue: machineValue('autonomy.release') }
        : {}),
    },
    userPreset,
    stages,
    ...(configWarning ? { warnings: [...(resolved.warnings ?? []), configWarning] } : {}),
  } as Omit<typeof resolved, 'stages' | 'rulings' | 'release'> & {
    userPreset?: AutonomyPreset | null
    stages: typeof stages
    rulings: typeof resolved.rulings & { machineValue?: string }
    release: typeof resolved.release & { machineValue?: string }
  }
}

const machineKey = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stage'), stage: z.enum(AUTONOMY_STAGES) }),
  z.object({ kind: z.literal('release') }),
  z.object({ kind: z.literal('rulings') }),
])

const machineSet = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stage'), stage: z.enum(AUTONOMY_STAGES), value: autonomyValue }),
  z.object({ kind: z.literal('release'), value: releaseValue }),
  z.object({ kind: z.literal('rulings'), value: rulingsValue }),
])

function autonomyMachineKey(input: z.infer<typeof machineKey>): string {
  return input.kind === 'stage' ? `autonomy.stage.${input.stage}` : `autonomy.${input.kind}`
}

function configConflict(error: unknown): error is TRPCError {
  return error instanceof TRPCError && error.code === 'CONFLICT'
}

async function localOverrideRemains(key: string, rowVersion: number): Promise<boolean> {
  try {
    await fromOrch(() => configDelete(key, rowVersion))
    return false
  } catch (error) {
    if (!configConflict(error)) throw error
  }
  const fresh = (await fromOrch(configList)).find(
    (candidate) => candidate.scope === 'user' && candidate.key === key,
  )
  if (!fresh) return false
  try {
    await fromOrch(() => configDelete(key, fresh.rowVersion))
    return false
  } catch (error) {
    if (!configConflict(error)) throw error
    return true
  }
}

async function clearLocalStageOverrides(entries: Awaited<ReturnType<typeof configList>>) {
  const remaining: string[] = []
  for (const stage of AUTONOMY_STAGES) {
    const key = `autonomy.stage.${stage}`
    const entry = entries.find((candidate) => candidate.scope === 'user' && candidate.key === key)
    if (entry && (await localOverrideRemains(key, entry.rowVersion))) remaining.push(stage)
  }
  if (remaining.length) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Preset was saved, but these stage overrides remain: ${remaining.join(', ')}`,
    })
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
        await fromOrch(() => configSet('autonomy.preset', input.value, input.expectedRowVersion))
        const entries = await fromOrch(configList)
        await clearLocalStageOverrides(entries)
        return localAutonomy(input.project)
      }),
    clearStage: mutation
      .input(
        z.object({
          project: z.string().min(1),
          stage: z.string().min(1),
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
        const key = `autonomy.stage.${input.stage}`
        const entry = (await fromOrch(configList)).find(
          (candidate) => candidate.scope === 'user' && candidate.key === key,
        )
        if (!entry) return { ...(await localAutonomy(input.project)), cleared: false }
        if (input.expectedRowVersion === null) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Current row version is not null' })
        }
        await fromOrch(() => configDelete(key, input.expectedRowVersion ?? entry.rowVersion))
        return { ...(await localAutonomy(input.project)), cleared: true }
      }),
    setMachine: mutation
      .input(z.object({ project: z.string().min(1) }).and(machineSet))
      .mutation(async ({ input }) => {
        projectPath(input.project)
        await fromOrch(() => machineConfigSet(autonomyMachineKey(input), input.value))
        return localAutonomy(input.project)
      }),
    clearMachine: mutation
      .input(z.object({ project: z.string().min(1) }).and(machineKey))
      .mutation(async ({ input }) => {
        projectPath(input.project)
        const key = autonomyMachineKey(input)
        const removed = (await fromOrch(machineConfigList)).some((entry) => entry.key === key)
        await fromOrch(() => machineConfigDelete(key))
        return { ...(await localAutonomy(input.project)), removed }
      }),
  }),
  settings: t.router({
    get: t.procedure.input(target).query(async ({ input }) => {
      const [result, machine] = await Promise.all([
        fromOrch(() => settingsCheck(input)),
        fromOrch(machinePermissions),
      ])
      return { ...result, mode: 'local', machine } as typeof result & {
        mode?: 'local'
        machine?: typeof machine
      }
    }),
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
    machinePermission: mutation
      .input(
        z.object({
          list: permissionList,
          rule: z.string().trim().min(1, 'Rule is required'),
          operation: z.enum(['add', 'remove', 'drop', 'undrop']),
        }),
      )
      .mutation(({ input }) => fromOrch(() => machinePermission(input), true)),
  }),
})
