import { expect, test } from 'bun:test'
import type { HostedProjectRow, RecordConfigSecretsResponse } from '@bottega/hub-data/client'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'
import type { CredentialPreference } from '../../../../shared/credential.ts'
import { credentialDisplayRows, preferenceDisplayRows, splitSecretRows } from './secrets.tsx'

const updatedAt = '2026-11-05T12:00:00.000Z'
const projects: HostedProjectRow[] = [
  {
    id: '01990000-0000-7000-8000-000000000011',
    spaceId: '01990000-0000-7000-8000-000000000010',
    spaceName: 'Workshop',
    name: PLATFORM_SLUG,
    keyPrefixes: ['DEV'],
    stack: null,
    managedContext: true,
    landingBranch: 'main',
    color: null,
    colorDark: null,
    retiredAt: null,
  },
]

const typedSecret: RecordConfigSecretsResponse[number] = {
  key: 'openrouter/api-key#live@local',
  environment: 'local',
  scope: 'user',
  projectId: '01990000-0000-7000-8000-000000000099',
  provider: 'openrouter',
  name: null,
  type: 'api-key',
  hint: 'sk-o...test',
  mode: 'live',
  updatedAt,
}

test('splits complete credentials from legacy keys and maps their display fields', () => {
  const sharedSecret = { ...typedSecret, key: 'stripe/api-key#test@local', scope: 'space' as const }
  const legacySecret = {
    ...typedSecret,
    key: 'LEGACY_KEY',
    provider: null,
    name: null,
    type: null,
    hint: null,
    mode: null,
  }

  const split = splitSecretRows([typedSecret, sharedSecret, legacySecret])
  const display = credentialDisplayRows(split.credentials, projects)

  expect(split.legacy).toEqual([legacySecret])
  expect(display.map(({ credential, boundTo, payer }) => ({ credential, boundTo, payer }))).toEqual(
    [
      { credential: 'openrouter/api-key', boundTo: 'Unknown project', payer: 'You' },
      { credential: 'openrouter/api-key', boundTo: 'Unknown project', payer: 'Shared' },
    ],
  )
})

test('maps a space-wide preference to all projects and its payer and binding', () => {
  const preference: CredentialPreference = {
    projectId: null,
    provider: 'openrouter',
    name: 'backup',
    type: 'api-key',
    mode: 'test',
    environment: 'local',
    payer: 'personal',
    binding: 'space',
    updatedAt,
  }

  expect(preferenceDisplayRows([preference], projects)).toEqual([
    {
      ...preference,
      credential: 'openrouter/backup/api-key',
      project: 'All projects',
      paysWith: 'You, space credential',
    },
  ])
})
