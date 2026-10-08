import { describe, expect, mock, test } from 'bun:test'
import { TRPCError } from '@trpc/server'
import type { RecordClient, RecordDoc } from '../../record-client.ts'
import { createHostedContextRouter } from './hosted-context.ts'

const userId = '01990000-0000-7000-8000-000000000001'
const docId = '01990000-0000-7000-8000-000000000002'
const revisionId = '01990000-0000-7000-8000-000000000003'
const nextRevisionId = '01990000-0000-7000-8000-000000000004'
const at = '2026-09-28T12:00:00.000Z'

const canonDoc: RecordDoc = {
  id: docId,
  spaceId: '01990000-0000-7000-8000-000000000010',
  spaceName: 'Personal',
  scope: 'canon',
  subject: null,
  owner: userId,
  slug: 'preferences',
  title: 'Preferences',
  body: 'Use concise prose.',
  delivery: 'inject',
  audience: 'technical',
  parentId: null,
  position: 0,
  summary: 'Use concise prose.',
  featured: false,
  status: 'current',
  replacementSlug: null,
  projectName: null,
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
}

const settingsDoc: RecordDoc = {
  ...canonDoc,
  scope: 'settings',
  slug: 'settings',
  title: 'settings',
  delivery: 'demand',
  body: JSON.stringify({
    permissions: { allow: ['Bash(git status)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'token=super-secret' }] }] },
    envKeys: ['API_TOKEN'],
  }),
}

function fakeClient(overrides: Partial<RecordClient> = {}) {
  const client = {
    whoami: mock(async () => ({
      user: { id: userId },
      activeSpaceId: '01990000-0000-7000-8000-000000000010',
      personalSpaceId: '01990000-0000-7000-8000-000000000010',
      memberships: [],
    })),
    projects: mock(async () => [
      {
        spaceId: '01990000-0000-7000-8000-000000000010',
        spaceName: 'Personal',
        name: 'alpha',
        keyPrefixes: ['ALPHA'],
        stack: 'bun',
        managedContext: true,
        landingBranch: 'main',
        color: null,
        colorDark: null,
        retiredAt: null,
      },
    ]),
    docs: mock(async (input?: { scope?: string }) => ({
      items: input?.scope === 'settings' ? [settingsDoc] : [canonDoc],
      nextCursor: null,
    })),
    doc: mock(async () => canonDoc),
    docRevisions: mock(async () => ({
      items: [
        {
          id: revisionId,
          docId,
          scope: 'canon',
          subject: null,
          owner: userId,
          slug: 'preferences',
          op: 'set' as const,
          title: 'Preferences',
          body: 'Use concise prose.',
          delivery: 'inject' as const,
          author: 'operator',
          reason: 'updated',
          sessionId: null,
          at,
        },
      ],
    })),
    putDoc: mock(async () => ({ id: docId, revisionId: nextRevisionId })),
    deleteDoc: mock(async () => ({ id: docId, revisionId: nextRevisionId })),
    configEntries: mock(async () => [
      {
        key: 'autonomy.stage.review',
        environment: 'default',
        scope: 'user' as const,
        value: 'auto',
        rowVersion: 3,
        updatedAt: at,
      },
      {
        key: 'autonomy.release',
        environment: 'default',
        scope: 'space' as const,
        value: 'land',
        rowVersion: 2,
        updatedAt: at,
      },
    ]),
    putConfigEntry: mock(
      async (key: string, input: { scope: 'user' | 'space'; value: string }) => ({
        key,
        environment: 'default',
        scope: input.scope,
        value: input.value,
        rowVersion: 1,
        updatedAt: at,
      }),
    ),
    deleteConfigEntry: mock(async () => ({ deleted: true as const })),
    settingsPermission: mock(async () => ({
      revision: nextRevisionId,
      permissions: { allow: ['Bash(git status)'], ask: [], deny: [] },
    })),
    ...overrides,
  }
  return client as unknown as RecordClient
}

function caller(client: RecordClient) {
  return createHostedContextRouter(() => client).createCaller({})
}

describe('hosted context router', () => {
  test('projects returns hosted project rows with managed context', async () => {
    await expect(caller(fakeClient()).projects()).resolves.toEqual([
      { name: 'alpha', path: null, managedContext: true, worktreeNote: null },
    ])
  })

  test('userCanon.list returns only the signed-in owner with a revision', async () => {
    const rows = await caller(fakeClient()).userCanon.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ slug: 'preferences', revision: revisionId, updated_at: at })
  })

  test('userCanon.get finds one owner-scoped row', async () => {
    await expect(
      caller(fakeClient()).userCanon.get({ slug: 'preferences' }),
    ).resolves.toMatchObject({
      id: docId,
      revision: revisionId,
    })
  })

  test('userCanon.set writes with the authenticated owner and expected revision', async () => {
    const client = fakeClient()
    await caller(client).userCanon.set({
      slug: 'preferences',
      title: 'Preferences',
      body: 'New body',
      reason: 'updated',
      expectedRevision: revisionId,
    })
    expect(client.putDoc).toHaveBeenCalledWith(
      expect.objectContaining({ owner: userId, expectedRevision: revisionId }),
    )
  })

  test('userCanon.remove deletes the owner-scoped row with the expected revision', async () => {
    const client = fakeClient()
    await expect(
      caller(client).userCanon.remove({
        slug: 'preferences',
        reason: 'obsolete',
        expectedRevision: revisionId,
      }),
    ).resolves.toEqual({ removed: true })
    expect(client.deleteDoc).toHaveBeenCalledWith(
      docId,
      expect.objectContaining({ expectedRevision: revisionId }),
    )
  })

  test('autonomy.get groups versioned user and space entries', async () => {
    const result = await caller(fakeClient()).autonomy.get({ project: 'alpha' })
    expect(result.mode).toBe('hosted')
    expect(result.stages).toContain('review')
    expect(result.user.stages.review).toEqual({ value: 'auto', rowVersion: 3 })
    expect(result.space.shipTo).toEqual({ value: 'trunk', rowVersion: null })
  })

  test('autonomy.get gives the stored ship-to key precedence over its release alias', async () => {
    const client = fakeClient()
    client.configEntries = mock(async () => [
      {
        key: 'autonomy.ship-to',
        environment: 'default',
        scope: 'user' as const,
        value: 'trunk',
        rowVersion: 3,
        updatedAt: at,
      },
      {
        key: 'autonomy.release',
        environment: 'default',
        scope: 'user' as const,
        value: 'promote',
        rowVersion: 2,
        updatedAt: at,
      },
    ])
    expect((await caller(client).autonomy.get({ project: 'alpha' })).user.shipTo).toEqual({
      value: 'trunk',
      rowVersion: 3,
    })
  })

  test('autonomy.set writes a versioned user stage and returns fresh entries', async () => {
    const client = fakeClient()
    await caller(client).autonomy.set({
      project: 'alpha',
      stage: 'review',
      value: 'review',
      expectedRowVersion: 3,
    })
    expect(client.putConfigEntry).toHaveBeenCalledWith('autonomy.stage.review', {
      scope: 'user',
      value: 'review',
      expectedRowVersion: 3,
    })
  })

  test('autonomy.setShipTo writes a versioned user ship-to level', async () => {
    const client = fakeClient()
    await caller(client).autonomy.setShipTo({
      project: 'alpha',
      value: 'production',
      expectedRowVersion: null,
    })
    expect(client.putConfigEntry).toHaveBeenCalledWith('autonomy.ship-to', {
      scope: 'user',
      value: 'production',
      expectedRowVersion: null,
    })
  })

  test('autonomy.setShipTo succeeds from an alias-only leaf and removes that row', async () => {
    const client = fakeClient()
    client.configEntries = mock(async () => [
      {
        key: 'autonomy.release',
        environment: 'default',
        scope: 'user' as const,
        value: 'land',
        rowVersion: 7,
        updatedAt: at,
      },
    ])
    const current = await caller(client).autonomy.get({ project: 'alpha' })
    expect(current.user.shipTo).toEqual({ value: 'trunk', rowVersion: null })
    await caller(client).autonomy.setShipTo({
      project: 'alpha',
      value: 'production',
      expectedRowVersion: current.user.shipTo?.rowVersion ?? null,
    })
    expect(client.deleteConfigEntry).toHaveBeenCalledWith('autonomy.release', {
      scope: 'user',
      expectedRowVersion: 7,
    })
  })

  test('autonomy.setPreset writes the preset and deletes each user stage override', async () => {
    const client = fakeClient()
    await caller(client).autonomy.setPreset({
      project: 'alpha',
      value: 'manual',
      expectedRowVersion: null,
    })
    expect(client.putConfigEntry).toHaveBeenCalledWith('autonomy.preset', {
      scope: 'user',
      value: 'manual',
      expectedRowVersion: null,
    })
    expect(client.deleteConfigEntry).toHaveBeenCalledWith('autonomy.stage.review', {
      scope: 'user',
      expectedRowVersion: 3,
    })
  })

  test('autonomy.clearStage deletes only the named override and reports absence', async () => {
    const client = fakeClient()
    const result = await caller(client).autonomy.clearStage({
      project: 'alpha',
      stage: 'review',
      expectedRowVersion: 3,
    })
    expect(result.cleared).toBe(true)
    expect(client.deleteConfigEntry).toHaveBeenCalledTimes(1)
    expect(client.deleteConfigEntry).toHaveBeenCalledWith('autonomy.stage.review', {
      scope: 'user',
      expectedRowVersion: 3,
    })

    const absentClient = fakeClient({ configEntries: mock(async () => []) as never })
    await expect(
      caller(absentClient).autonomy.clearStage({
        project: 'alpha',
        stage: 'review',
        expectedRowVersion: null,
      }),
    ).resolves.toMatchObject({ cleared: false })
    expect(absentClient.deleteConfigEntry).not.toHaveBeenCalled()
  })

  test('autonomy.setPreset retries a conflict and reports overrides still left', async () => {
    let lists = 0
    const configEntries = mock(async () => {
      lists += 1
      if (lists === 1) {
        return [
          {
            key: 'autonomy.stage.review',
            environment: 'default',
            scope: 'user' as const,
            value: 'auto',
            rowVersion: 3,
            updatedAt: at,
          },
          {
            key: 'autonomy.stage.ship',
            environment: 'default',
            scope: 'user' as const,
            value: 'auto',
            rowVersion: 8,
            updatedAt: at,
          },
        ]
      }
      return [
        {
          key: 'autonomy.stage.review',
          environment: 'default',
          scope: 'user' as const,
          value: 'auto',
          rowVersion: 4,
          updatedAt: at,
        },
      ]
    })
    const deleteConfigEntry = mock(async (key: string) => {
      if (key.endsWith('review')) {
        throw new TRPCError({ code: 'CONFLICT', message: 'current rowVersion changed' })
      }
      return { deleted: true as const }
    })
    const client = fakeClient({ configEntries, deleteConfigEntry: deleteConfigEntry as never })

    await expect(
      caller(client).autonomy.setPreset({
        project: 'alpha',
        value: 'manual',
        expectedRowVersion: null,
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('review'),
    })
    expect(deleteConfigEntry).toHaveBeenCalledWith('autonomy.stage.review', {
      scope: 'user',
      expectedRowVersion: 4,
    })
    expect(deleteConfigEntry).toHaveBeenCalledWith('autonomy.stage.ship', {
      scope: 'user',
      expectedRowVersion: 8,
    })
  })

  test('settings.get returns shared summaries without hook commands or secret material', async () => {
    const result = await caller(fakeClient()).settings.get({ user: true })
    const serialized = JSON.stringify(result)
    expect(result).toMatchObject({
      mode: 'hosted',
      revision: revisionId,
      file: { path: null, exists: null },
      drift: null,
      findings: null,
      settings: { envKeys: ['API_TOKEN'] },
    })
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('command')
    expect(result.settings.hooks[0]?.matcher).toBe('secret-shaped')
  })

  test('settings.get withholds a secret-shaped hook matcher from stored rows', async () => {
    const secret = 'Authorization: Bearer sk-proj-stored-before-screening'
    const client = fakeClient({
      docs: mock(async () => ({
        items: [
          {
            ...settingsDoc,
            body: JSON.stringify({
              permissions: {},
              hooks: { PreToolUse: [{ matcher: secret }] },
              envKeys: [],
            }),
          },
        ],
        nextCursor: null,
      })) as never,
    })

    const result = await caller(client).settings.get({ user: true })
    expect(result.settings.hooks[0]?.matcher).toBe('[withheld: secret-shaped]')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  test('settings.permission posts the hosted address unchanged', async () => {
    const client = fakeClient()
    await caller(client).settings.permission({
      target: { project: 'alpha' },
      list: 'allow',
      rule: 'Bash(orch *)',
      operation: 'add',
      reason: 'needed',
      expectedRevision: revisionId,
    })
    expect(client.settingsPermission).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'project', project: 'alpha' } }),
    )
  })

  test('preserves a record conflict for the page', async () => {
    const client = fakeClient({
      putConfigEntry: mock(async () => {
        throw new TRPCError({ code: 'CONFLICT', message: 'current rowVersion is 4' })
      }) as never,
    })
    await expect(
      caller(client).autonomy.set({
        project: 'alpha',
        stage: 'review',
        value: 'auto',
        expectedRowVersion: 3,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'current rowVersion is 4' })
  })
})
