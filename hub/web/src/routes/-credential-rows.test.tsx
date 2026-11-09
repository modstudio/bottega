import { expect, test } from 'bun:test'
import type { HostedProjectRow, RecordConfigSecretsResponse } from '@bottega/hub-data/client'
import type { CredentialPreference } from '../../../../shared/credential.ts'
import {
  credentialDisplayRows,
  credentialRowMatches,
  typedCredentialRows,
} from './-credential-rows.tsx'

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

test('typed credential rows omit incomplete sealed configuration keys', () => {
  const complete = typedCredentialRows([secret('space', null)])[0]!
  const incomplete: RecordConfigSecretsResponse[number] = {
    ...complete,
    key: 'untyped-key',
    provider: null,
    type: null,
    hint: null,
    mode: null,
  }
  expect(typedCredentialRows([complete, incomplete])).toEqual([complete])
})

test('a space preference selects the shared copy for every project and the space default', () => {
  const rows = credentialDisplayRows(typedCredentialRows(copies), [preference], projects, spaceId)
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
  const rows = credentialDisplayRows(typedCredentialRows(copies), [], projects, spaceId)
  expect(rows.map((row) => row.usages.map((usage) => `${usage.name}:${usage.reason}`))).toEqual([
    ['A:default-order'],
    ['C:default-order', 'Space default:default-order'],
    ['B:default-order'],
  ])
})

test('a space-wide personal project preference selects each project copy', () => {
  const projectPreference: CredentialPreference = {
    ...preference,
    payer: 'personal',
    binding: 'project',
  }
  const rows = credentialDisplayRows(
    typedCredentialRows([secret('user', projects[0]!.id), secret('user', projects[1]!.id)]),
    [projectPreference],
    projects,
    spaceId,
  )
  expect(rows.map((row) => row.usages.map((usage) => `${usage.name}:${usage.reason}`))).toEqual([
    ['A:space-preference'],
    ['B:space-preference'],
  ])
  expect(rows.map((row) => row.preferences)).toEqual([[projectPreference], [projectPreference]])
  expect(rows.every((row) => !row.missing)).toBe(true)
})

test('a project preference selects its copy or becomes missing while default order remains', () => {
  const personalPreference: CredentialPreference = {
    ...preference,
    projectId: projects[0]!.id,
    payer: 'personal',
    binding: 'project',
  }
  const credentials = typedCredentialRows([secret('user', projects[0]!.id)])
  const selected = credentialDisplayRows(credentials, [personalPreference], projects, spaceId)
  expect(selected).toHaveLength(1)
  expect(selected[0]!.usages.map((usage) => `${usage.name}:${usage.reason}`)).toEqual([
    'A:project-preference',
  ])
  expect(selected[0]!.preferences).toEqual([personalPreference])

  const sharedPreference = { ...personalPreference, payer: 'shared' as const }
  const missing = credentialDisplayRows(credentials, [sharedPreference], projects, spaceId)
  expect(missing).toHaveLength(2)
  expect(missing[0]!.usages.map((usage) => `${usage.name}:${usage.reason}`)).toEqual([
    'A:default-order',
  ])
  expect(missing[1]).toMatchObject({ missing: true, usages: [], preferences: [sharedPreference] })
})

test('a retired project uses no copy', () => {
  const withRetired = [projects[0]!, { ...projects[2]!, retiredAt: updatedAt }]
  const rows = credentialDisplayRows(
    typedCredentialRows([secret('space', null)]),
    [],
    withRetired,
    spaceId,
  )
  expect(rows[0]!.usages.map((usage) => usage.name)).toEqual(['A', 'Space default'])
})

test('search matches a project the copy is used by', () => {
  const named = projects.map((project, index) => ({
    ...project,
    name: ['Atlas', 'Beacon', 'Comet'][index]!,
  }))
  const rows = credentialDisplayRows(typedCredentialRows(copies), [], named, spaceId)
  const matched = rows.filter((row) => credentialRowMatches(row, 'COMET'))
  expect(matched.map((row) => row.usages.map((usage) => usage.name))).toEqual([
    ['Comet', 'Space default'],
  ])
  const preferred = credentialDisplayRows(typedCredentialRows(copies), [preference], named, spaceId)
  const count = (query: string) =>
    preferred.filter((row) => credentialRowMatches(row, query)).length
  expect(count('openrouter · api-key')).toBe(3)
  expect(count('(preferred)')).toBe(1)
  expect(count('local')).toBe(0)
})

test('a preference with no stored slot produces a missing row with no usage', () => {
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
    usages: [],
  })
})
