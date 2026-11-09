import { expect, test } from 'bun:test'
import {
  type CredentialCandidate,
  credentialDisplayName,
  credentialHint,
  parseCredentialSlot,
  resolveCredential,
} from './credential-resolution.ts'

const base = {
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

test('credential slots use the shared payer and binding grammar', () => {
  expect(parseCredentialSlot('shared@project')).toEqual({ payer: 'shared', binding: 'project' })
  expect(parseCredentialSlot('shared@other')).toBeNull()
})

test("another space's credential is never selected", () => {
  const result = resolveCredential({
    ...base,
    candidates: [candidate('personal', base.projectId, 'space-b')],
    preferences: [],
  })
  expect(result.kind).toBe('refused')
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

test('hints mask only long values and display names show mode and environment', () => {
  expect(credentialHint('12345678901234567890')).toBe('1234…7890')
  expect(credentialHint('short')).toBe('5 characters')
  expect(credentialDisplayName('openrouter', null, 'api-key', 'test', 'local')).toBe(
    'openrouter/api-key (mode test, env local)',
  )
})
