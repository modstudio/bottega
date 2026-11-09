import { expect, test } from 'bun:test'
import { type CredentialCandidate, resolveCredential } from './credential-resolution.ts'

const base = {
  userId: 'user-a',
  personalSpaceId: 'personal-space-a',
  spaceId: 'space-a',
  projectId: 'project-a',
  projectName: 'alpha',
  provider: 'openrouter',
  name: null,
  type: 'api-key',
  mode: 'default' as const,
  environment: 'local' as const,
}
const candidate = (
  payer: CredentialCandidate['payer'],
  projectId: string | null,
  spaceId = base.spaceId,
): CredentialCandidate => ({ ...base, payer, projectId, spaceId })
const account = (
  reachSpaceIds: readonly string[] | null = null,
  ownerUserId = base.userId,
  spaceId = base.personalSpaceId,
): CredentialCandidate => ({
  ...candidate('personal', null, spaceId),
  account: { ownerUserId, reachSpaceIds },
})

test('resolver uses personal project, personal space, project shared, then space shared', () => {
  const rows = [
    candidate('shared', null),
    candidate('shared', base.projectId),
    candidate('personal', null),
    candidate('personal', base.projectId),
  ]
  for (let index = rows.length - 1; index >= 0; index--) {
    const result = resolveCredential({
      ...base,
      candidates: rows.slice(0, index + 1),
      preferences: [],
    })
    expect(result.kind === 'resolved' ? result.credential : null).toEqual(rows[index]!)
  }
})

test('a project preference wins while a stale preference falls back', () => {
  const rows = [candidate('personal', base.projectId), candidate('shared', null)]
  const preferred = resolveCredential({
    ...base,
    candidates: rows,
    preferences: [{ ...base, projectId: base.projectId, payer: 'shared', binding: 'space' }],
  })
  expect(preferred).toMatchObject({
    kind: 'resolved',
    credential: rows[1]!,
    reason: 'project-preference',
  })
  const stale = resolveCredential({
    ...base,
    candidates: [rows[0]!],
    preferences: [{ ...base, projectId: base.projectId, payer: 'shared', binding: 'space' }],
  })
  expect(stale).toMatchObject({ kind: 'resolved', credential: rows[0]!, reason: 'default-order' })
})

test('preferences match the complete provider, name, type, mode, and environment identity', () => {
  const rows = [candidate('personal', base.projectId), candidate('shared', null)]
  for (const mismatch of [
    { provider: 'inception' },
    { name: 'backup' },
    { type: 'token' },
    { mode: 'test' as const },
  ]) {
    expect(
      resolveCredential({
        ...base,
        candidates: rows,
        preferences: [
          {
            ...base,
            projectId: base.projectId,
            payer: 'shared',
            binding: 'space',
            ...mismatch,
          },
        ],
      }),
    ).toMatchObject({ kind: 'resolved', credential: rows[0], reason: 'default-order' })
  }
})

test('a space preference wins over the default order', () => {
  const rows = [candidate('personal', base.projectId), candidate('shared', null)]
  expect(
    resolveCredential({
      ...base,
      candidates: rows,
      preferences: [{ ...base, projectId: null, payer: 'shared', binding: 'space' }],
    }),
  ).toMatchObject({ kind: 'resolved', credential: rows[1], reason: 'space-preference' })
})

test('space resolution uses personal before shared', () => {
  const rows = [candidate('shared', null), candidate('personal', null)]
  expect(
    resolveCredential({
      ...base,
      projectId: null,
      spaceName: 'alpha-space',
      candidates: rows,
      preferences: [],
    }),
  ).toMatchObject({ kind: 'resolved', credential: rows[1], reason: 'default-order' })
})

test('a space preference wins during space resolution', () => {
  const rows = [candidate('personal', null), candidate('shared', null)]
  expect(
    resolveCredential({
      ...base,
      projectId: null,
      spaceName: 'alpha-space',
      candidates: rows,
      preferences: [{ ...base, projectId: null, payer: 'shared', binding: 'space' }],
    }),
  ).toMatchObject({ kind: 'resolved', credential: rows[1], reason: 'space-preference' })
})

test('space resolution excludes project-bound credentials', () => {
  expect(
    resolveCredential({
      ...base,
      projectId: null,
      spaceName: 'alpha-space',
      candidates: [candidate('personal', base.projectId)],
      preferences: [],
    }),
  ).toMatchObject({ kind: 'refused' })
})

test('a project slot preference beats the default payer order', () => {
  const rows = [
    candidate('shared', base.projectId),
    candidate('personal', base.projectId),
    candidate('shared', null),
  ]
  expect(
    resolveCredential({
      ...base,
      candidates: rows,
      preferences: [{ ...base, projectId: base.projectId, payer: 'shared', binding: 'project' }],
    }),
  ).toMatchObject({ kind: 'resolved', credential: rows[0], reason: 'project-preference' })
})

test("another space's credential is never selected", () => {
  const result = resolveCredential({
    ...base,
    candidates: [candidate('personal', base.projectId, 'space-b')],
    preferences: [],
  })
  expect(result.kind).toBe('refused')
})

test('account credential pays after personal bindings and before shared bindings', () => {
  const rows = [
    candidate('shared', null),
    candidate('shared', base.projectId),
    account(),
    candidate('personal', null),
    candidate('personal', base.projectId),
  ]
  for (let index = rows.length - 1; index >= 0; index--) {
    expect(
      resolveCredential({ ...base, candidates: rows.slice(0, index + 1), preferences: [] }),
    ).toMatchObject({ kind: 'resolved', credential: rows[index] })
  }
})

test('account reach excludes an unlisted space while all reaches any space', () => {
  expect(
    resolveCredential({ ...base, candidates: [account(['space-b'])], preferences: [] }),
  ).toMatchObject({ kind: 'refused' })
  expect(
    resolveCredential({ ...base, spaceId: 'new-space', candidates: [account()], preferences: [] }),
  ).toMatchObject({ kind: 'resolved', reason: 'account' })
})

test('account preference wins and a stale account preference falls back', () => {
  const personal = candidate('personal', base.projectId)
  const preference = {
    ...base,
    projectId: base.projectId,
    payer: 'personal' as const,
    binding: 'account' as const,
  }
  expect(
    resolveCredential({ ...base, candidates: [personal, account()], preferences: [preference] }),
  ).toMatchObject({ kind: 'resolved', credential: { account: {} }, reason: 'account' })
  expect(
    resolveCredential({
      ...base,
      candidates: [personal, account(['space-b'])],
      preferences: [preference],
    }),
  ).toMatchObject({ kind: 'resolved', credential: personal, reason: 'default-order' })
})

test("another user's or another personal space's account credential is never selected", () => {
  for (const row of [account(null, 'user-b'), account(null, base.userId, 'personal-space-b')])
    expect(resolveCredential({ ...base, candidates: [row], preferences: [] })).toMatchObject({
      kind: 'refused',
    })
})

test('resolver matches credential mode', () => {
  const testMode = { ...candidate('personal', base.projectId), mode: 'test' as const }
  expect(resolveCredential({ ...base, candidates: [testMode], preferences: [] })).toMatchObject({
    kind: 'refused',
  })
  expect(
    resolveCredential({ ...base, mode: 'test', candidates: [testMode], preferences: [] }),
  ).toMatchObject({ kind: 'resolved', credential: testMode })
})

test('resolver never crosses credential names', () => {
  const named = { ...candidate('personal', base.projectId), name: 'backup' }
  expect(resolveCredential({ ...base, candidates: [named], preferences: [] })).toMatchObject({
    kind: 'refused',
  })
  expect(
    resolveCredential({ ...base, name: 'backup', candidates: [named], preferences: [] }),
  ).toMatchObject({ kind: 'resolved', credential: named })
})
