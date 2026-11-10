import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  AUTONOMY_PRESETS,
  AUTONOMY_STAGES,
  AUTONOMY_VALUES,
  type AutonomyStage,
  RULINGS_CONFIG_KEY,
  RULINGS_VALUES,
} from '../../../../shared/autonomy.ts'
import { parseRecordSpaceMemberships } from '../../../../shared/record-space-membership.ts'
import { recordWriteSpace } from '../../../../shared/record-write-space.ts'
import { summarizeSettings } from '../../../../shared/settings-summary.ts'
import {
  readStoredShipTo,
  SHIP_TO_CONFIG_KEY,
  SHIP_TO_VALUES,
  STORED_SHIP_TO_CONFIG_ALIAS,
} from '../../../../shared/ship-to.ts'
import { type OwnedSettings, parseStoredSettingsRow } from '../../../../shared/stored-settings.ts'
import {
  createRecordClient,
  type RecordClient,
  type RecordConfigEntry,
  type RecordDoc,
  requiredRecordApiUrl,
} from '../../record-client.ts'
import type { Context } from '../context.ts'
import { projects } from '../../projects.ts'

const t = initTRPC.context<Context>().create()
const slug = z.string().trim().min(1, 'Slug is required')
const reason = z.string().trim().min(1, 'Reason is required')
const expectedRevision = z.string().uuid().optional()
const expectedRowVersion = z.number().int().positive().nullable()
const project = z.string().min(1)
const target = z.union([z.object({ user: z.literal(true) }), z.object({ project })])

type ClientFactory = (context: Context) => RecordClient
type ProjectSpaceFactory = typeof projects

function defaultClient(context: Context): RecordClient {
  return createRecordClient({
    baseUrl: requiredRecordApiUrl(),
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
    const page = await client.docs({ ...input, limit: 100, cursor }, destinationSpaceId)
    rows.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return rows
}

async function personalSpace(client: RecordClient): Promise<{ userId: string; spaceId: string }> {
  const identity = await client.whoami()
  const decision = recordWriteSpace(
    { kind: 'personal' },
    { declaredSpaces: {}, personalSpaceId: identity.personalSpaceId, memberships: [] },
  )
  if ('refused' in decision) throw new TRPCError({ code: 'CONFLICT', message: decision.remedy })
  return { userId: identity.user.id, spaceId: decision.spaceId }
}

async function allPersonalDocs(client: RecordClient, input: { scope: string; subject?: string }) {
  const personal = await personalSpace(client)
  const rows: RecordDoc[] = []
  let cursor: string | undefined
  do {
    const page = await client.docs({ ...input, limit: 100, cursor }, personal.spaceId)
    rows.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return { personal, rows }
}

async function currentRevision(client: RecordClient, id: string, destinationSpaceId?: string) {
  const revisions = await client.docRevisions(id, undefined, destinationSpaceId)
  return revisions.items[0]?.id ?? null
}

async function canonRow(client: RecordClient, row: RecordDoc, destinationSpaceId?: string) {
  return {
    id: row.id,
    scope: row.scope,
    subject: row.subject,
    slug: row.slug,
    title: row.title,
    body: row.body,
    delivery: row.delivery,
    revision: await currentRevision(client, row.id, destinationSpaceId),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

async function userCanonRows(client: RecordClient) {
  const { personal, rows } = await allPersonalDocs(client, { scope: 'canon', subject: '' })
  return {
    user: { id: personal.userId },
    spaceId: personal.spaceId,
    rows: rows.filter((row) => row.subject === null && row.owner === personal.userId),
  }
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
    rulings: leaf(entry(RULINGS_CONFIG_KEY)),
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

function parseStoredSettings(body: string): OwnedSettings {
  try {
    return parseStoredSettingsRow(body)
  } catch (error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function settingsRow(
  client: RecordClient,
  address: z.infer<typeof target>,
  registeredProjects: ProjectSpaceFactory,
): Promise<{ row: RecordDoc; destination: string | undefined }> {
  const subject = 'user' in address ? '' : address.project
  const identity = await client.whoami()
  const registered = registeredProjects()
  const owner = 'user' in address
    ? ({ kind: 'personal' } as const)
    : ({ kind: 'project', name: address.project } as const)
  const decision = recordWriteSpace(
    owner,
    {
      declaredSpaces: Object.fromEntries(registered.map((project) => [project.name, project.settings.space])),
      personalSpaceId: identity.personalSpaceId,
      memberships: parseRecordSpaceMemberships(identity.memberships),
    },
  )
  if ('refused' in decision) throw new TRPCError({ code: 'CONFLICT', message: decision.remedy })
  const destination = decision.spaceId
  const rows = await allDocs(client, { scope: 'settings', subject }, destination)
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
  return { row, destination }
}

async function hostedSettingsGet(
  client: RecordClient,
  input: z.infer<typeof target>,
  registeredProjects: ProjectSpaceFactory,
) {
  const { row, destination } = await settingsRow(client, input, registeredProjects)
  return {
    mode: 'hosted' as const,
    target:
      'user' in input
        ? { kind: 'user' as const }
        : { kind: 'project' as const, name: input.project },
    file: { path: null, exists: null },
    revision: await currentRevision(client, row.id, destination),
    settings: summarizeSettings(parseStoredSettings(row.body)),
    drift: null,
    findings: null,
  }
}

/** Writes one of the user's own config entries, guarded by the row version the screen read. */
function putUserEntry(
  client: RecordClient,
  key: string,
  input: { value: string; expectedRowVersion: number | null },
) {
  return client.putConfigEntry(key, {
    scope: 'user',
    value: input.value,
    expectedRowVersion: input.expectedRowVersion,
  })
}

export function createHostedContextRouter(
  clientFor: ClientFactory = defaultClient,
  registeredProjects: ProjectSpaceFactory = projects,
) {
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
        const { rows, spaceId } = await userCanonRows(client)
        return Promise.all(rows.map((row) => canonRow(client, row, spaceId)))
      }),
      get: t.procedure.input(z.object({ slug })).query(async ({ ctx, input }) => {
        const client = clientFor(ctx)
        const { rows, spaceId } = await userCanonRows(client)
        const row = rows.find((candidate) => candidate.slug === input.slug)
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'canon doc not found' })
        return canonRow(client, row, spaceId)
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
          const { userId, spaceId } = await personalSpace(client)
          const written = await client.putDoc(
            {
              scope: 'canon',
              subject: null,
              owner: userId,
              slug: input.slug,
              title: input.title,
              body: input.body,
              delivery: 'inject',
              reason: input.reason,
              author: userId,
              expectedRevision: input.expectedRevision,
            },
            spaceId,
          )
          return canonRow(client, await client.doc(written.id, undefined, spaceId), spaceId)
        }),
      remove: t.procedure
        .input(z.object({ slug, reason, expectedRevision }))
        .mutation(async ({ ctx, input }) => {
          const client = clientFor(ctx)
          const { user, rows, spaceId } = await userCanonRows(client)
          const row = rows.find((candidate) => candidate.slug === input.slug)
          if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'canon doc not found' })
          await client.deleteDoc(
            row.id,
            {
              reason: input.reason,
              author: user.id,
              expectedRevision: input.expectedRevision,
            },
            spaceId,
          )
          return { removed: true }
        }),
    }),
    autonomy: t.router({
      get: t.procedure
        .input(z.object({ project }))
        .query(({ ctx, input }) => hostedAutonomy(clientFor(ctx), input.project)),
      set: t.procedure
        .input(
          z.object({
            project,
            stage: z.enum(AUTONOMY_STAGES),
            value: z.enum(AUTONOMY_VALUES),
            expectedRowVersion,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const client = clientFor(ctx)
          await putUserEntry(client, `autonomy.stage.${input.stage}`, input)
          return hostedAutonomy(client, input.project)
        }),
      setShipTo: t.procedure
        .input(z.object({ project, value: z.enum(SHIP_TO_VALUES), expectedRowVersion }))
        .mutation(async ({ ctx, input }) => {
          const client = clientFor(ctx)
          await putUserEntry(client, SHIP_TO_CONFIG_KEY, input)
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
      setRulings: t.procedure
        .input(z.object({ project, value: z.enum(RULINGS_VALUES), expectedRowVersion }))
        .mutation(async ({ ctx, input }) => {
          const client = clientFor(ctx)
          await putUserEntry(client, RULINGS_CONFIG_KEY, input)
          return hostedAutonomy(client, input.project)
        }),
      setPreset: t.procedure
        .input(z.object({ project, value: z.enum(AUTONOMY_PRESETS), expectedRowVersion }))
        .mutation(async ({ ctx, input }) => {
          const client = clientFor(ctx)
          await putUserEntry(client, 'autonomy.preset', input)
          const entries = await client.configEntries()
          await clearHostedStageOverrides(client, entries)
          return hostedAutonomy(client, input.project)
        }),
      clearStage: t.procedure
        .input(
          z.object({
            project,
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
      get: t.procedure
        .input(target)
        .query(({ ctx, input }) => hostedSettingsGet(clientFor(ctx), input, registeredProjects)),
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
        .mutation(({ ctx, input }) =>
          clientFor(ctx).settingsPermission({
            ...input,
            target:
              'user' in input.target
                ? { kind: 'user' as const }
                : { kind: 'project' as const, project: input.target.project },
          }),
        ),
    }),
  })
}

export const hostedContextRouter = createHostedContextRouter()
