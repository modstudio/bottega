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
  ...overrides,
})

const local = (overrides: Partial<LocalAgentDeclaration> = {}): LocalAgentDeclaration => ({
  ...declared(),
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

test('probe tables include only never-probed rows and pending registrations', () => {
  const rows = [local(), local({ name: 'failed', probedAt: 'now' })]
  const registrations = [{ name: 'new', mutation: { harness: 'codex' as const } }]
  expect(probesWithProject({ local: rows, registrations, projectPath: '/project' })).toEqual([
    'new',
    'worker',
  ])
  expect(probesWithoutProject({ local: rows, registrations, projectPath: null })).toEqual([
    'new',
    'worker',
  ])
})
