import { expect, test } from 'bun:test'
import type { VerdictPayload } from '../verdict/verdict-payload.ts'
import { releaseValues } from './record-release-sync.ts'
import { reviewReadRecordValues } from './record-review-read.ts'
import { commonReviewRecordValues } from './record-review-values.ts'
import { branchDisposalValues } from './record-sync-branch-disposal.ts'
import type { RecordPayload } from './record-sync-contract.ts'
import { pullRequestCiValues } from './record-sync-pull-request-ci.ts'
import { runRecordValues } from './record-sync-run-values.ts'
import {
  contentionValues,
  landingOverrideValues,
  landingValues,
  questionValues,
  reviewFindingValues,
  reviewLensValues,
  reviewValues,
  testFlakeValues,
} from './record-sync-service.ts'
import { scoreValues } from './score-sync.ts'

const STAMP = '2026-10-29T20:00:00.000Z'
const ID = '01990000-0000-7000-8000-000000001885'
const OTHER_ID = '01990000-0000-7000-8000-000000001886'
const ARRAY = ['evidence']
const OBJECT = { load: 1 }

const payload: RecordPayload = {
  id: ID,
  spaceId: ID,
  projectId: ID,
  projectName: 'project',
  machineId: ID,
  localId: 1,
  startedAt: STAMP,
  finishedAt: STAMP,
  agent: 'codex',
  job: 'implement',
  promptSha: 'prompt',
  promptBytes: 1,
  promptHead: 'prompt',
  probe: false,
  status: 'ok',
  turn: 1,
  noFailover: false,
  automaticFailover: false,
  workPreserved: false,
  recordedAt: STAMP,
  createdAt: STAMP,
  updatedAt: STAMP,
  changedPaths: ARRAY,
  docRevisions: ARRAY,
  outsideWorktreeWrites: ARRAY,
  reviewProvenance: OBJECT,
  provisioningPhases: ARRAY,
  provisioningHostLoad: OBJECT,
  hostAdmissionFirst: OBJECT,
  hostAdmission: OBJECT,
  provisioningEntryRoots: ARRAY,
  withheldFields: ARRAY,
  delivery: 'full',
  quality: 'right',
  fidelity: 'right',
  note: 'note',
  scoredAt: STAMP,
  scoredBy: 'architect',
  reproduced: null,
  coverage: null,
  limits: null,
  overlap: null,
  tierReasons: ARRAY,
  pathSet: ARRAY,
  role: 'round',
  reviewId: OTHER_ID,
  reviewLensId: OTHER_ID,
  runId: OTHER_ID,
  lens: 'correctness',
  standardsRead: ARRAY,
  filesCovered: ARRAY,
  commandsRun: ARRAY,
  couldNotVerify: ARRAY,
  mcpTools: ARRAY,
  docsRead: ARRAY,
  substitutes: ARRAY,
  ordinal: 1,
  severity: 'blocking',
  location: 'file.ts:1',
  evidence: 'evidence',
  proposedCorrection: 'correct it',
  branch: 'DEV-1885-jsonb',
  tip: 'tip',
  patchId: 'patch',
  tier: 1,
  sessionId: 'session',
  trunkBefore: 'trunk',
  error: null,
  requestedAt: STAMP,
  steps: ARRAY,
  tree: 'tree',
  reason: 'reason',
  attribution: 'operator',
  missingLenses: ARRAY,
  at: STAMP,
  prNumber: 1,
  recordKind: 'completed',
  failedJobs: ARRAY,
  resourceKind: 'gate',
  resourceKey: 'gate',
  eventKind: 'wait',
  hostLoad: OBJECT,
  loadAtFailure: OBJECT,
  test: 'test',
  file: 'file.ts',
  archiveRef: 'refs/archive/dev-1885',
  archiveExpiresAt: STAMP,
  actorSession: 'session',
  disposedAt: STAMP,
  revision: 1,
  askedAt: STAMP,
  question: 'Proceed?',
  options: ARRAY,
  audits: ARRAY,
  rung: 'production',
  candidateCommit: 'candidate',
  rollback: false,
  actor: 'operator',
}

const common = commonReviewRecordValues(payload)

const cases: Array<{
  name: string
  values: () => Record<string, unknown>
  fields: string[]
}> = [
  {
    name: 'run',
    values: () => runRecordValues(payload, ID, ID, ID),
    fields: [
      'changedPaths',
      'docRevisions',
      'outsideWorktreeWrites',
      'reviewProvenance',
      'provisioningPhases',
      'provisioningHostLoad',
      'hostAdmissionFirst',
      'hostAdmission',
      'provisioningEntryRoots',
      'withheldFields',
    ],
  },
  {
    name: 'score',
    values: () => scoreValues(payload as VerdictPayload),
    fields: ['withheldFields'],
  },
  {
    name: 'review',
    values: () => reviewValues(payload, ID),
    fields: ['tierReasons', 'pathSet', 'withheldFields'],
  },
  {
    name: 'review lens',
    values: () => reviewLensValues(payload),
    fields: [
      'standardsRead',
      'filesCovered',
      'commandsRun',
      'couldNotVerify',
      'mcpTools',
      'docsRead',
      'substitutes',
      'withheldFields',
    ],
  },
  {
    name: 'review finding',
    values: () => reviewFindingValues(payload),
    fields: ['withheldFields'],
  },
  {
    name: 'review read',
    values: () => reviewReadRecordValues(payload, ID, common),
    fields: ['pathSet', 'withheldFields'],
  },
  {
    name: 'landing',
    values: () => landingValues(payload, ID),
    fields: ['pathSet', 'steps', 'withheldFields'],
  },
  {
    name: 'landing override',
    values: () => landingOverrideValues(payload, ID),
    fields: ['pathSet', 'missingLenses', 'withheldFields'],
  },
  {
    name: 'pull request CI',
    values: () => pullRequestCiValues(payload, ID),
    fields: ['failedJobs', 'withheldFields'],
  },
  {
    name: 'contention',
    values: () => contentionValues(payload),
    fields: ['hostLoad', 'withheldFields'],
  },
  {
    name: 'test flake',
    values: () => testFlakeValues(payload),
    fields: ['loadAtFailure', 'withheldFields'],
  },
  {
    name: 'branch disposal',
    values: () => branchDisposalValues(payload, ID),
    fields: ['withheldFields'],
  },
  {
    name: 'question',
    values: () => questionValues(payload, ID, ID),
    fields: ['options', 'withheldFields'],
  },
  {
    name: 'release',
    values: () => releaseValues(payload, ID),
    fields: ['withheldFields'],
  },
]

test.each(cases)('$name sync values keep jsonb fields structured', ({ values, fields }) => {
  const result = values()
  for (const field of fields) {
    expect(result[field]).not.toBeNull()
    expect(typeof result[field]).not.toBe('string')
  }
})
