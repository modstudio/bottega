import { expect, test } from 'bun:test'
import {
  type CredentialCandidate,
  credentialDisplayName,
  credentialHint,
  credentialVariableName,
  resolveCredential,
} from './credential.ts'

const base = {
  spaceId: 'space-a',
  projectId: 'project-a',
  projectName: 'alpha',
  userId: 'user-a',
  provider: 'openrouter',
  type: 'api-key',
  environment: 'default' as const,
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
    expect(result.kind === 'resolved' ? result.credential : null).toEqual(rows[index])
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
    credential: rows[1],
    reason: 'project-preference',
  })
  const stale = resolveCredential({
    ...base,
    candidates: [rows[0]],
    preferences: [{ ...base, projectId: base.projectId, payer: 'shared', binding: 'space' }],
  })
  expect(stale).toMatchObject({ kind: 'resolved', credential: rows[0], reason: 'default-order' })
})

test("another space's credential is never selected", () => {
  const result = resolveCredential({
    ...base,
    candidates: [candidate('personal', base.projectId, 'space-b')],
    preferences: [],
  })
  expect(result.kind).toBe('refused')
})

test('hints mask only long values and names are derived', () => {
  expect(credentialHint('12345678901234567890')).toBe('1234…7890')
  expect(credentialHint('short')).toBe('5 characters')
  expect(credentialVariableName('better-auth', 'secret-key', 'default')).toBe(
    'BETTER_AUTH_SECRET_KEY',
  )
  expect(credentialVariableName('openrouter', 'api-key', 'test')).toBe('OPENROUTER_API_KEY_TEST')
  expect(credentialDisplayName('openrouter', 'api-key', 'test')).toBe('openrouter/api-key/test')
})
