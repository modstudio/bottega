import { expect, test } from 'bun:test'
import type { RecordSpaceAgent } from '../record/record-space-agents.ts'
import {
  declarationDrift,
  type LocalAgentDeclaration,
  missingDeclaration,
  probesWithoutProject,
  probesWithProject,
} from './setup-agent-declarations.ts'

const declared = (overrides: Partial<RecordSpaceAgent> = {}): RecordSpaceAgent => ({
  name: 'worker',
  harness: 'codex',
  backend: 'vendor',
  model: 'gpt',
  baseUrl: null,
  transport: 'cli',
  provider: null,
  apiKeySecret: 'provider-key',
  requestSettings: null,
  jobs: ['writing'],
  preferredJobs: null,
  maxConcurrent: 2,
  routeMetered: false,
  trainsOnInputs: false,
  operatedBy: 'vendor',
  billing: 'subscription',
  enabled: true,
  disabledReason: null,
  ...overrides,
})

const local = (overrides: Partial<LocalAgentDeclaration> = {}): LocalAgentDeclaration => ({
  ...declared(),
  enabled: true,
  probedAt: null,
  ...overrides,
})

test('missing table offers valid rows and copies only the secret name', () => {
  expect(missingDeclaration(declared(), undefined)).toEqual({
    kind: 'register',
    registration: {
      name: 'worker',
      mutation: expect.objectContaining({ apiKeySecret: 'provider-key' }),
    },
  })
})

test('missing table carries a disabled declaration and its reason', () => {
  expect(
    missingDeclaration(
      declared({ enabled: false, disabledReason: 'subscription ended' }),
      undefined,
    ),
  ).toMatchObject({
    kind: 'register',
    registration: {
      mutation: { enabled: false, reason: 'subscription ended' },
    },
  })
})

test.each([
  [{ backend: null }, 'backend'],
  [{ backend: 'future' }, 'backend'],
  [{ operatedBy: 'self' }, 'operatedBy'],
] as const)('missing table notices an unregistrable %s', (overrides, field) => {
  expect(missingDeclaration(declared(overrides), undefined)).toEqual({ kind: 'notice', field })
})

test('drift table names declared fields and ignores probe state', () => {
  expect(declarationDrift(declared(), local({ model: 'other', probedAt: 'now' }))).toEqual([
    'model',
  ])
})

test('drift table ignores request settings object key order', () => {
  expect(
    declarationDrift(
      declared({ requestSettings: { alpha: 1, beta: 2 } }),
      local({ requestSettings: { beta: 2, alpha: 1 } }),
    ),
  ).toEqual([])
})

test('probe tables include only never-probed rows and pending registrations', () => {
  const registrations = [{ name: 'new', mutation: { harness: 'codex' as const } }]
  const existingProbeNames = ['worker']
  expect(probesWithProject({ existingProbeNames, registrations, projectPath: '/project' })).toEqual(
    ['new', 'worker'],
  )
  expect(probesWithoutProject({ existingProbeNames, registrations })).toEqual(['new', 'worker'])
})
