import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  AUTONOMY_PRESETS,
  AUTONOMY_STAGES,
  AUTONOMY_VALUES,
  type AutonomyStage,
} from '../../../../shared/autonomy.ts'
import { parseRecordSpaceMemberships } from '../../../../shared/record-space-membership.ts'
import { type StoredSettings, summarizeSettings } from '../../../../shared/settings-summary.ts'
import {
  readStoredShipTo,
  SHIP_TO_CONFIG_KEY,
  SHIP_TO_VALUES,
  STORED_SHIP_TO_CONFIG_ALIAS,
} from '../../../../shared/ship-to.ts'
import { projects } from '../../projects.ts'
import {
  createRecordClient,
  type RecordClient,
  type RecordConfigEntry,
  type RecordDoc,
} from '../../record-client.ts'
import { taskProjectDestination } from '../../task-project-space.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()
const slug = z.string().trim().min(1, 'Slug is required')
const reason = z.string().trim().min(1, 'Reason is required')
const expectedRevision = z.string().uuid().optional()
const expectedRowVersion = z.number().int().positive().nullable()
const target = z.union([
  z.object({ user: z.literal(true) }),
  z.object({ project: z.string().min(1) }),
])

type ClientFactory = (context: Context) => RecordClient

function defaultClient(context: Context): RecordClient {
  const baseUrl = process.env.HUB_RECORD_API_URL
  if (!baseUrl) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'HUB_RECORD_API_URL is required',
    })
  }
  return createRecordClient({
    baseUrl,
    headers: { cookie: context.cookie, authorization: context.authorization },
  })
}

async function allDocs(
  client: RecordClient,
  input: { scope: string; subject?: string },
  destinationSpaceId?: string,
) {
  const rows: RecordDoc[] = []
  let cursor: string | undefined
  do {
    const query = { ...input, limit: 100, cursor }
    const page = destinationSpaceId
      ? await client.docs(query, destinationSpaceId)
      : await client.docs(query)
    rows.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return rows
}

async function currentRevision(client: RecordClient, id: string, destinationSpaceId?: string) {
  const revisions = destinationSpaceId
    ? await client.docRevisions(id, destinationSpaceId)
    : await client.docRevisions(id)
  return revisions.items[0]?.id ?? null
}

async function canonRow(client: RecordClient, row: RecordDoc) {
  return {
    id: row.id,
    scope: row.scope,
    subject: row.subject,
    slug: row.slug,
    title: row.title,
    body: row.body,
    delivery: row.delivery,
    revision: await currentRevision(client, row.id),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

async function userCanonRows(client: RecordClient) {
  const [{ user }, rows] = await Promise.all([
    client.whoami(),
    allDocs(client, { scope: 'canon', subject: '' }),
  ])
  return rows.filter((row) => row.subject === null && row.owner === user.id)
}

const leaf = (entry: RecordConfigEntry | undefined) =>
  entry ? { value: entry.value, rowVersion: entry.rowVersion } : null

const shipToLeaf = (
  shipToEntry: RecordConfigEntry | undefined,
  releaseEntry: RecordConfigEntry | undefined,
) => {
  const read = readStoredShipTo(
    shipToEntry?.value,
    releaseEntry?.value,
    shipToEntry !== undefined,
    releaseEntry !== undefined,
  )
  return read.level ? { value: read.level, rowVersion: shipToEntry?.rowVersion ?? null } : null
}

function scopedAutonomy(entries: RecordConfigEntry[], scope: 'user' | 'space') {
  const selected = entries.filter((entry) => entry.scope === scope)
  const entry = (key: string) => selected.find((candidate) => candidate.key === key)
  return {
    preset: leaf(entry('autonomy.preset')),
    rulings: leaf(entry('autonomy.rulings')),
    shipTo: shipToLeaf(entry(SHIP_TO_CONFIG_KEY), entry(STORED_SHIP_TO_CONFIG_ALIAS)),
    stages: Object.fromEntries(
      AUTONOMY_STAGES.map((stage) => [stage, leaf(entry(`autonomy.stage.${stage}`))]),
    ) as Record<AutonomyStage, ReturnType<typeof leaf>>,
  }
}

async function hostedAutonomy(client: RecordClient, project: string) {
  const entries = await client.configEntries()
  return {
    mode: 'hosted' as const,
    project,
    stages: AUTONOMY_STAGES,
    user: scopedAutonomy(entries, 'user'),
    space: scopedAutonomy(entries, 'space'),
  }
}

function hostedConfigConflict(error: unknown): error is TRPCError {
  return error instanceof TRPCError && error.code === 'CONFLICT'
}

async function hostedOverrideRemains(
  client: RecordClient,
  key: string,
  rowVersion: number,
): Promise<boolean> {
  try {
    await client.deleteConfigEntry(key, { scope: 'user', expectedRowVersion: rowVersion })
    return false
  } catch (error) {
    if (!hostedConfigConflict(error)) throw error
  }
  const fresh = (await client.configEntries()).find(
    (candidate) => candidate.scope === 'user' && candidate.key === key,
  )
  if (!fresh) return false
  try {
    await client.deleteConfigEntry(key, {
      scope: 'user',
      expectedRowVersion: fresh.rowVersion,
    })
    return false
  } catch (error) {
    if (!hostedConfigConflict(error)) throw error
    return true
  }
}

async function clearHostedStageOverrides(client: RecordClient, entries: RecordConfigEntry[]) {
  const remaining: string[] = []
  for (const stage of AUTONOMY_STAGES) {
    const key = `autonomy.stage.${stage}`
    const entry = entries.find((candidate) => candidate.scope === 'user' && candidate.key === key)
    if (entry && (await hostedOverrideRemains(client, key, entry.rowVersion))) remaining.push(stage)
  }
  if (remaining.length) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Preset was saved, but these stage overrides remain: ${remaining.join(', ')}`,
    })
  }
}

function parseStoredSettings(body: string): StoredSettings {
  let value: unknown
  try {
    value = JSON.parse(body) as unknown
  } catch {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'stored settings are invalid' })
  }
  const parsed = z
    .object({ permissions: z.unknown(), hooks: z.unknown(), envKeys: z.array(z.string()) })
    .strict()
    .safeParse(value)
  if (!parsed.success) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'stored settings are invalid' })
  }
  return parsed.data
}

async function settingsRow(
  client: RecordClient,
  address: z.infer<typeof target>,
): Promise<{ row: RecordDoc; destinationSpaceId?: string }> {
  const subject = 'user' in address ? '' : address.project
  const identity = await client.whoami()
  let destinationSpaceId: string | undefined
  if ('project' in address) {
    if (!identity.activeSpaceId)
      throw new TRPCError({ code: 'CONFLICT', message: 'record session has no active space' })
    const destination = taskProjectDestination(address.project, projects(), {
      activeSpaceId: identity.activeSpaceId,
      memberships: parseRecordSpaceMemberships(identity.memberships),
    })
    if ('refused' in destination) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `signed-in user is not a member of the declared record space for project ${address.project}`,
      })
    }
    destinationSpaceId = destination.destinationSpaceId
  }
  const rows = await allDocs(client, { scope: 'settings', subject }, destinationSpaceId)
  const row = rows.find((candidate) =>
    'user' in address
      ? candidate.subject === null &&
        candidate.owner === identity.user.id &&
        candidate.slug === 'settings'
      : candidate.subject === address.project &&
        candidate.owner === null &&
        candidate.slug === 'settings',
  )
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'settings doc not found' })
  return { row, destinationSpaceId }
}

export function createHostedContextRouter(clientFor: ClientFactory = defaultClient) {
  return t.router({
    projects: t.procedure.query(async ({ ctx }) =>
      (await clientFor(ctx).projects()).map((project) => ({
        name: project.name,
        path: null,
        managedContext: project.managedContext,
        worktreeNote: null,
      })),
    ),
    userCanon: t.router({
      list: t.procedure.query(async ({ ctx }) => {
        const client = clientFor(ctx)
        return Promise.all((await userCanonRows(client)).map((row) => canonRow(client, row)))
      }),
      get: t.procedure.input(z.object({ slug })).query(async ({ ctx, input }) => {
        const client = clientFor(ctx)
        const row = (await userCanonRows(client)).find((candidate) => candidate.slug === input.slug)
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'canon doc not found' })
        return canonRow(client, row)
      }),
      set: t.procedure
        .input(
          z.object({
            slug,
            title: z.string().trim().min(1, 'Title is required'),
            body: z.string(),
            reason,
            expectedRevision,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const client = clientFor(ctx)
          const { user } = await client.whoami()
          const written = await client.putDoc({
            scope: 'canon',
            subject: null,
            owner: user.id,
            slug: input.slug,
            title: input.title,
            body: input.body,
            delivery: 'inject',
            reason: input.reason,
            author: 'hub-dashboard',
            expectedRevision: input.expectedRevision,
          })
          return canonRow(client, await client.doc(written.id))
        }),
      remove: t.procedure
        .input(z.object({ slug, reason, expectedRevision }))
        .mutation(async ({ ctx, input }) => {
          const client = clientFor(ctx)
          const row = (await userCanonRows(client)).find(
            (candidate) => candidate.slug === input.slug,
          )
          if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'canon doc not found' })
          await client.deleteDoc(row.id, {
            reason: input.reason,
            author: 'hub-dashboard',
            expectedRevision: input.expectedRevision,
          })
          return { removed: true }
        }),
    }),
    autonomy: t.router({
      get: t.procedure
        .input(z.object({ project: z.string().min(1) }))
        .query(({ ctx, input }) => hostedAutonomy(clientFor(ctx), input.project)),
      set: t.procedure
        .input(
          z.object({
            project: z.string().min(1),
            stage: z.enum(AUTONOMY_STAGES),
            value: z.enum(AUTONOMY_VALUES),
            expectedRowVersion,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const client = clientFor(ctx)
          await client.putConfigEntry(`autonomy.stage.${input.stage}`, {
            scope: 'user',
            value: input.value,
            expectedRowVersion: input.expectedRowVersion,
          })
          return hostedAutonomy(client, input.project)
        }),
      setShipTo: t.procedure
        .input(
          z.object({
            project: z.string().min(1),
            value: z.enum(SHIP_TO_VALUES),
            expectedRowVersion,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const client = clientFor(ctx)
          await client.putConfigEntry(SHIP_TO_CONFIG_KEY, {
            scope: 'user',
            value: input.value,
            expectedRowVersion: input.expectedRowVersion,
          })
          const alias = (await client.configEntries()).find(
            (entry) => entry.scope === 'user' && entry.key === STORED_SHIP_TO_CONFIG_ALIAS,
          )
          if (alias)
            await client.deleteConfigEntry(STORED_SHIP_TO_CONFIG_ALIAS, {
              scope: 'user',
              expectedRowVersion: alias.rowVersion,
            })
          return hostedAutonomy(client, input.project)
        }),
      setPreset: t.procedure
        .input(
          z.object({
            project: z.string().min(1),
            value: z.enum(AUTONOMY_PRESETS),
            expectedRowVersion,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const client = clientFor(ctx)
          await client.putConfigEntry('autonomy.preset', {
            scope: 'user',
            value: input.value,
            expectedRowVersion: input.expectedRowVersion,
          })
          const entries = await client.configEntries()
          await clearHostedStageOverrides(client, entries)
          return hostedAutonomy(client, input.project)
        }),
      clearStage: t.procedure
        .input(
          z.object({
            project: z.string().min(1),
            stage: z.enum(AUTONOMY_STAGES),
            expectedRowVersion,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const client = clientFor(ctx)
          const key = `autonomy.stage.${input.stage}`
          const entry = (await client.configEntries()).find(
            (candidate) => candidate.scope === 'user' && candidate.key === key,
          )
          if (!entry) return { ...(await hostedAutonomy(client, input.project)), cleared: false }
          if (input.expectedRowVersion === null) {
            throw new TRPCError({ code: 'CONFLICT', message: 'Current row version is not null' })
          }
          await client.deleteConfigEntry(key, {
            scope: 'user',
            expectedRowVersion: input.expectedRowVersion,
          })
          return { ...(await hostedAutonomy(client, input.project)), cleared: true }
        }),
    }),
    settings: t.router({
      get: t.procedure.input(target).query(async ({ ctx, input }) => {
        const client = clientFor(ctx)
        const { row, destinationSpaceId } = await settingsRow(client, input)
        return {
          mode: 'hosted' as const,
          target:
            'user' in input
              ? { kind: 'user' as const }
              : { kind: 'project' as const, name: input.project },
          file: { path: null, exists: null },
          revision: await currentRevision(client, row.id, destinationSpaceId),
          settings: summarizeSettings(parseStoredSettings(row.body)),
          drift: null,
          findings: null,
        }
      }),
      permission: t.procedure
        .input(
          z.object({
            target,
            list: z.enum(['allow', 'ask', 'deny']),
            rule: z.string().trim().min(1, 'Rule is required'),
            operation: z.enum(['add', 'remove']),
            reason,
            expectedRevision: z.string().uuid(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const client = clientFor(ctx)
          const { destinationSpaceId } = await settingsRow(client, input.target)
          const write = {
            ...input,
            target:
              'user' in input.target
                ? { kind: 'user' as const }
                : { kind: 'project' as const, project: input.target.project },
          }
          return destinationSpaceId
            ? client.settingsPermission(write, destinationSpaceId)
            : client.settingsPermission(write)
        }),
    }),
  })
}

export const hostedContextRouter = createHostedContextRouter()
