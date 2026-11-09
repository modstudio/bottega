import { expect, test } from 'bun:test'
import type { HostedProjectRow, RecordConfigSecretsResponse } from '@bottega/hub-data/client'
import type { CredentialPreference } from '../../../../shared/credential.ts'
import { credentialDisplayRows, splitSecretRows } from './secrets.tsx'

const spaceId = '01990000-0000-7000-8000-000000000010'
const updatedAt = '2026-11-05T12:00:00.000Z'
const projects: HostedProjectRow[] = ['A', 'B', 'C'].map((name, index) => ({
  id: `01990000-0000-7000-8000-00000000001${index + 1}`,
  spaceId,
  spaceName: 'Workshop',
  name,
  keyPrefixes: [name],
  stack: null,
  managedContext: true,
  landingBranch: 'main',
  color: null,
  colorDark: null,
  retiredAt: null,
}))

function secret(
  scope: 'user' | 'space',
  projectId: string | null,
): RecordConfigSecretsResponse[number] {
  return {
    key: 'openrouter/api-key#live@local',
    environment: 'local',
    scope,
    projectId,
    provider: 'openrouter',
    name: null,
    type: 'api-key',
    hint: 'sk-o...test',
    mode: 'live',
    updatedAt,
  }
}

const copies = [
  secret('user', projects[0]!.id),
  secret('space', null),
  secret('user', projects[1]!.id),
]
const preference: CredentialPreference = {
  projectId: null,
  provider: 'openrouter',
  name: null,
  type: 'api-key',
  mode: 'live',
  environment: 'local',
  payer: 'shared',
  binding: 'space',
  updatedAt,
}

test('a space preference selects the shared copy for every project and the space default', () => {
  const rows = credentialDisplayRows(
    splitSecretRows(copies).credentials,
    [preference],
    projects,
    spaceId,
  )
  expect(
    rows.map((row) => ({
      owner: row.owner,
      usedBy: row.usages.map((usage) => `${usage.name}:${usage.reason}`),
    })),
  ).toEqual([
    { owner: 'You', usedBy: [] },
    {
      owner: 'This space',
      usedBy: [
        'A:space-preference',
        'B:space-preference',
        'C:space-preference',
        'Space default:space-preference',
      ],
    },
    { owner: 'You', usedBy: [] },
  ])
})

test('default order uses project copies before the shared space copy', () => {
  const rows = credentialDisplayRows(splitSecretRows(copies).credentials, [], projects, spaceId)
  expect(rows.map((row) => row.usages.map((usage) => `${usage.name}:${usage.reason}`))).toEqual([
    ['A:default-order'],
    ['C:default-order', 'Space default:default-order'],
    ['B:default-order'],
  ])
})

test('a preference with no stored slot produces a missing row', () => {
  const missing = {
    ...preference,
    projectId: projects[0]!.id,
    payer: 'personal' as const,
    binding: 'space' as const,
  }
  const rows = credentialDisplayRows([], [missing], projects, spaceId)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    credential: 'openrouter/api-key',
    boundTo: 'A',
    owner: '—',
    hint: 'missing',
    missing: true,
  })
  expect(rows[0]!.key.startsWith('missing:')).toBe(true)
})

test('owner labels are shared by personal and space credentials', () => {
  const rows = credentialDisplayRows(splitSecretRows(copies).credentials, [], projects, spaceId)
  expect(rows.map((row) => row.owner)).toEqual(['You', 'This space', 'You'])
})
