// concern: record-sync-contract
/** The single transport-neutral payload contract for every hosted evidence kind. */
import { VERDICT_PAYLOAD_COLUMNS } from '../verdict/verdict-payload.ts'

const columns = (names: string): readonly string[] => names.split(' ')
const contract = (
  names: string | readonly string[],
  laterAdded: Readonly<Record<string, unknown>> = {},
) => ({ columns: typeof names === 'string' ? columns(names) : names, laterAdded })

const RUN_RECORD_PAYLOAD_COLUMNS = columns(
  'id spaceId projectId projectName machineId localId startedByUserId startedAt finishedAt agent job promptSha specSha promptBytes promptHead taskKey label lens latencyMs exitCode outputBytes vendorTokens vendorCostUsd vendorInputTokens vendorOutputTokens vendorEstimatedCostUsd vendorCostSource resourceCpuMs resourcePeakRssBytes resourceSamples resourceSource probe failureKind status error retryOf parentRunId turn filesChanged changedPaths linesAdded linesRemoved testsRan testsPassed testsClaimDisagrees deviations escalations stack model evidenceExcluded evidenceUnvoid inputTree headCommit reviewRef reviewRole branch baseCommit mintedBranch docsInjected docRevisions canonSha transport sessionId routeReason noFailover automaticFailover outsideWorktreeWrites reviewProvenance provenanceStatus workPreserved closeOutOutcome closeOutDetail provisioningKind provisioningMs provisioningPhases provisioningEntries provisioningEntriesLimited provisioningHostLoad provisioningOutcome provisioningEntryRoots withheldFields createdAt updatedAt',
)
const RUN_RECORD_PAYLOAD_CONTRACT = contract(RUN_RECORD_PAYLOAD_COLUMNS, {
  projectId: null,
  startedByUserId: null,
  taskKey: null,
  reviewRole: null,
  evidenceUnvoid: null,
  vendorInputTokens: null,
  vendorOutputTokens: null,
  vendorEstimatedCostUsd: null,
  vendorCostSource: null,
  resourceCpuMs: null,
  resourcePeakRssBytes: null,
  resourceSamples: null,
  resourceSource: null,
  provisioningKind: null,
  provisioningMs: null,
  provisioningPhases: null,
  provisioningEntries: null,
  provisioningEntriesLimited: null,
  provisioningHostLoad: null,
  provisioningOutcome: null,
  provisioningEntryRoots: null,
  testsClaimDisagrees: null,
  withheldFields: null,
})

const SCORE_RECORD_PAYLOAD_COLUMNS = VERDICT_PAYLOAD_COLUMNS
const SCORE_RECORD_PAYLOAD_CONTRACT = contract(SCORE_RECORD_PAYLOAD_COLUMNS, {
  projectId: null,
  projectName: null,
  reproduced: null,
  coverage: null,
  limits: null,
  overlap: null,
  withheldFields: null,
})

const QUESTION_RECORD_PAYLOAD_COLUMNS = columns(
  // workflowCursorId is accepted and ignored because queued payloads are frozen.
  'id spaceId runId workflowKey workflowCursorId workflowCursorRecordId projectId projectName machineId localId revision askedAt question options recommendation why askedVia answer answerBasis answeredAt answeredBy answererKind answerChannel awaitingOperatorAt relayedBy overturnedAt overturnedBy overturnReason replacement filedAs filedRef filedRecordId filedLabel filedAt closedAt closeReason withheldFields audits createdAt updatedAt',
)
const QUESTION_RECORD_PAYLOAD_CONTRACT = contract(QUESTION_RECORD_PAYLOAD_COLUMNS, {
  workflowCursorRecordId: null,
  workflowCursorId: null,
  projectId: null,
  filedRecordId: null,
  filedLabel: null,
  answerBasis: null,
})

const REVIEW_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName machineId localId recordedAt completedAt tier tierRisk tierSize tierReasons tierReason role patchId pathSet commitMessage outdatedAt outdatedReason withheldFields createdAt updatedAt',
  { projectId: null, role: 'round', withheldFields: null },
)
const REVIEW_LENS_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName reviewId runId machineId localId lens agent model treeInspected reviewedTree standardsRead filesCovered commandsRun couldNotVerify mcpTools docsRead substitutes reproduced coverage limits overlap withheldFields createdAt updatedAt',
  { projectId: null, projectName: null, withheldFields: null },
)
const REVIEW_FINDING_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName reviewId reviewLensId machineId localId ordinal severity location evidence proposedCorrection disposition rejectionCategory triagedSeverity triagedAt duplicateOfFindingId withheldFields createdAt updatedAt',
  { projectId: null, projectName: null, duplicateOfFindingId: null, withheldFields: null },
)
const REVIEW_READ_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName machineId localId branch tip patchId pathSet tier note sessionId recordedAt withheldFields createdAt updatedAt',
  { projectId: null, projectName: null, withheldFields: null },
)

const RELEASE_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName machineId localId rung candidateCommit trunk trunkTip commitsBehindTrunk behindTrunkReason liveCommitBefore liveCommitAfter rollback rollbackReason actor sessionId startedAt finishedAt exitCode liveMatchesCandidate warning withheldFields createdAt updatedAt',
  {
    projectId: null,
    trunk: null,
    trunkTip: null,
    commitsBehindTrunk: null,
    behindTrunkReason: null,
  },
)

const LANDING_RECORD_PAYLOAD_COLUMNS = columns(
  'id spaceId projectId projectName machineId localId branch tip trunkBefore status error sessionId startedAt finishedAt pathSet requestedAt steps causingLandingId withheldFields createdAt updatedAt',
)
const LANDING_RECORD_PAYLOAD_CONTRACT = contract(LANDING_RECORD_PAYLOAD_COLUMNS, {
  projectId: null,
  withheldFields: null,
})
const LANDING_OVERRIDE_RECORD_PAYLOAD_COLUMNS = columns(
  'id spaceId projectId projectName machineId localId branch tip tree patchId pathSet reason attribution missingLenses sessionId at withheldFields createdAt updatedAt',
)
const LANDING_OVERRIDE_RECORD_PAYLOAD_CONTRACT = contract(LANDING_OVERRIDE_RECORD_PAYLOAD_COLUMNS, {
  projectId: null,
  patchId: null,
  pathSet: null,
  attribution: 'operator',
  missingLenses: [],
  withheldFields: null,
})
const LANDING_REVIEW_CARRY_RECORD_PAYLOAD_COLUMNS = columns(
  'id spaceId projectId projectName machineId localId branch tip tree reviewId reviewedCommit reviewedTree patchId oldBase newBase sessionId at createdAt updatedAt',
)
const LANDING_REVIEW_CARRY_RECORD_PAYLOAD_CONTRACT = contract(
  LANDING_REVIEW_CARRY_RECORD_PAYLOAD_COLUMNS,
  { projectId: null },
)
const LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_COLUMNS = columns(
  'id spaceId projectId projectName machineId localId branch tip tree prNumber reviewIds patchId tier lensRounds findingCount admissionPath readId overrideId sessionId at createdAt updatedAt',
)
const LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_CONTRACT = contract(
  LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_COLUMNS,
  { projectId: null, admissionPath: 'exact_review', readId: null },
)
const PULL_REQUEST_CI_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName machineId localId prNumber recordKind complete error workflowRunId runAttempt workflowName event headCommit conclusion failedJobs workflowCreatedAt workflowCompletedAt recordedAt withheldFields createdAt updatedAt',
  { projectId: null, withheldFields: null },
)
const CONTENTION_RECORD_PAYLOAD_COLUMNS = columns(
  'id spaceId machineId localId at sessionId resourceKind resourceKey eventKind durationMs cause runId landingId withheldFields createdAt updatedAt',
)
const CONTENTION_RECORD_PAYLOAD_CONTRACT = contract(CONTENTION_RECORD_PAYLOAD_COLUMNS, {
  withheldFields: null,
})
const TEST_FLAKE_RECORD_PAYLOAD_COLUMNS = columns(
  'id spaceId projectName machineId localId test file loadAtFailure signal at withheldFields createdAt updatedAt',
)
const TEST_FLAKE_RECORD_PAYLOAD_CONTRACT = contract(TEST_FLAKE_RECORD_PAYLOAD_COLUMNS, {
  withheldFields: null,
})
const BRANCH_DISPOSAL_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName machineId localId branch tip taskKey reason note archiveRef archiveExpiresAt actorSession disposedAt withheldFields createdAt updatedAt',
  { projectId: null, taskKey: null, withheldFields: null },
)

export const OUTBOX_PAYLOAD_CONTRACTS = {
  run: RUN_RECORD_PAYLOAD_CONTRACT,
  score: SCORE_RECORD_PAYLOAD_CONTRACT,
  question: QUESTION_RECORD_PAYLOAD_CONTRACT,
  review: REVIEW_RECORD_PAYLOAD_CONTRACT,
  review_lens: REVIEW_LENS_RECORD_PAYLOAD_CONTRACT,
  review_finding: REVIEW_FINDING_RECORD_PAYLOAD_CONTRACT,
  review_read: REVIEW_READ_RECORD_PAYLOAD_CONTRACT,
  release: RELEASE_RECORD_PAYLOAD_CONTRACT,
  landing: LANDING_RECORD_PAYLOAD_CONTRACT,
  landing_override: LANDING_OVERRIDE_RECORD_PAYLOAD_CONTRACT,
  landing_review_carry: LANDING_REVIEW_CARRY_RECORD_PAYLOAD_CONTRACT,
  landing_triage_snapshot: LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_CONTRACT,
  pull_request_ci: PULL_REQUEST_CI_RECORD_PAYLOAD_CONTRACT,
  contention: CONTENTION_RECORD_PAYLOAD_CONTRACT,
  test_flake: TEST_FLAKE_RECORD_PAYLOAD_CONTRACT,
  branch_disposal: BRANCH_DISPOSAL_RECORD_PAYLOAD_CONTRACT,
} as const
