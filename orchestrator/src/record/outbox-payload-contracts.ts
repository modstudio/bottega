// concern: record-sync-contract
/** The single transport-neutral payload contract for every hosted evidence kind. */
import { VERDICT_PAYLOAD_COLUMNS } from '../verdict/verdict-payload.ts'

const columns = (names: string): readonly string[] => names.split(' ')
const contract = (
  names: string | readonly string[],
  laterAdded: Readonly<Record<string, unknown>> = {},
) => ({ columns: typeof names === 'string' ? columns(names) : names, laterAdded })

const RUN_RECORD_PAYLOAD_COLUMNS = columns(
  'id number spaceId projectId projectName machineId localId startedByUserId startedAt finishedAt agent job promptSha specSha promptBytes promptHead taskKey taskId label lens latencyMs exitCode outputBytes vendorTokens modelCalls peakCallTokens contextSystemChars contextToolCount contextToolSchemaChars contextCompactions contextCacheReadTokens quotaUsedPercentStart quotaUsedPercentEnd quotaWindowMinutes quotaResetsAt vendorCostUsd vendorInputTokens vendorOutputTokens vendorEstimatedCostUsd vendorCostSource resourceCpuMs resourcePeakRssBytes resourceSamples resourceSource probe failureKind status error retryOf parentRunId turn cursorRecordId stepSlug filesChanged changedPaths linesAdded linesRemoved testsRan testsPassed testsClaimDisagrees deviations escalations stack model executor evidenceExcluded evidenceUnvoid inputTree headCommit reviewRef reviewRole branch baseCommit mintedBranch docsInjected docRevisions canonSha transport sessionId routeReason credentialId credentialPayer credentialBinding noFailover automaticFailover outsideWorktreeWrites reviewProvenance provenanceStatus workPreserved closeOutOutcome closeOutDetail provisioningKind provisioningMs provisioningPhases provisioningEntries provisioningEntriesLimited provisioningHostLoad hostAdmissionFirst hostAdmission provisioningOutcome provisioningEntryRoots withheldFields createdAt updatedAt',
)
const RUN_RECORD_PAYLOAD_CONTRACT = contract(RUN_RECORD_PAYLOAD_COLUMNS, {
  number: null,
  projectId: null,
  startedByUserId: null,
  taskKey: null,
  taskId: undefined,
  reviewRole: null,
  executor: null,
  credentialId: null,
  credentialPayer: null,
  credentialBinding: null,
  cursorRecordId: null,
  stepSlug: null,
  evidenceUnvoid: null,
  modelCalls: null,
  peakCallTokens: null,
  contextSystemChars: null,
  contextToolCount: null,
  contextToolSchemaChars: null,
  contextCompactions: null,
  contextCacheReadTokens: null,
  quotaUsedPercentStart: null,
  quotaUsedPercentEnd: null,
  quotaWindowMinutes: null,
  quotaResetsAt: null,
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
  hostAdmissionFirst: null,
  hostAdmission: null,
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

const TASK_FLOW_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName taskId state openStageRecordId openingMachineId updatedMachineId machineId revision createdAt updatedAt',
)
const TASK_FLOW_STAGE_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName flowRecordId workflow mode workflowKey instanceId sessionId workflowVersionId catalogueVersionId arguments activeOrdinal activeSlug state closedStepNotes question autonomy enforcement totalSteps openedMachineId takenOverFromMachineId lastAdvancedMachineId machineId revision createdAt updatedAt',
  {
    projectId: null,
    workflowKey: null,
    instanceId: null,
    sessionId: null,
    question: null,
    autonomy: null,
    enforcement: null,
  },
)

const REVIEW_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName machineId localId recordedAt completedAt tier tierRisk tierSize tierInsertions tierDeletions tierReasons tierReason role patchId zeroContextPatchId pathSet commitMessage outdatedAt outdatedReason round withheldFields createdAt updatedAt',
  {
    projectId: null,
    role: 'round',
    round: null,
    withheldFields: null,
    tierInsertions: null,
    tierDeletions: null,
    zeroContextPatchId: null,
  },
)
const REVIEW_LENS_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName reviewId runId machineId localId lens agent model treeInspected reviewedTree standardsRead filesCovered commandsRun couldNotVerify mcpTools docsRead substitutes reproduced coverage limits overlap selectionReason taskTextInput rulingsInput withheldFields createdAt updatedAt',
  {
    projectId: null,
    projectName: null,
    selectionReason: null,
    taskTextInput: null,
    rulingsInput: null,
    withheldFields: null,
  },
)
const REVIEW_FINDING_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName reviewId reviewLensId machineId localId ordinal severity location evidence proposedCorrection disposition rejectionCategory triagedSeverity triagedAt duplicateOfFindingId withheldFields createdAt updatedAt',
  { projectId: null, projectName: null, duplicateOfFindingId: null, withheldFields: null },
)
const REVIEW_READ_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName machineId localId branch tip patchId zeroContextPatchId pathSet tier note sessionId recordedAt withheldFields createdAt updatedAt',
  { projectId: null, projectName: null, zeroContextPatchId: null, withheldFields: null },
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
  'id spaceId projectId projectName machineId localId branch tip tree patchId zeroContextPatchId pathSet reason attribution missingLenses sessionId at withheldFields createdAt updatedAt',
)
const LANDING_OVERRIDE_RECORD_PAYLOAD_CONTRACT = contract(LANDING_OVERRIDE_RECORD_PAYLOAD_COLUMNS, {
  projectId: null,
  patchId: null,
  zeroContextPatchId: null,
  pathSet: null,
  attribution: 'operator',
  missingLenses: [],
  withheldFields: null,
})
const LANDING_REVIEW_CARRY_RECORD_PAYLOAD_COLUMNS = columns(
  'id spaceId projectId projectName machineId localId branch tip tree reviewId reviewedCommit reviewedTree patchId zeroContextPatchId oldBase newBase sessionId at createdAt updatedAt',
)
const LANDING_REVIEW_CARRY_RECORD_PAYLOAD_CONTRACT = contract(
  LANDING_REVIEW_CARRY_RECORD_PAYLOAD_COLUMNS,
  { projectId: null, zeroContextPatchId: null },
)
const LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_COLUMNS = columns(
  'id spaceId projectId projectName machineId localId branch tip tree prNumber reviewIds patchId zeroContextPatchId tier lensRounds findingCount admissionPath readId overrideId sessionId at createdAt updatedAt',
)
const LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_CONTRACT = contract(
  LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_COLUMNS,
  { projectId: null, zeroContextPatchId: null, admissionPath: 'exact_review', readId: null },
)
const PULL_REQUEST_CI_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName machineId localId prNumber recordKind complete error workflowRunId runAttempt workflowName event headCommit conclusion failedJobs workflowCreatedAt workflowCompletedAt recordedAt withheldFields createdAt updatedAt',
  { projectId: null, withheldFields: null },
)
const CONTENTION_RECORD_PAYLOAD_COLUMNS = columns(
  'id spaceId machineId localId at sessionId resourceKind resourceKey eventKind durationMs occurrences cause runId landingId hostLoad withheldFields createdAt updatedAt',
)
const CONTENTION_RECORD_PAYLOAD_CONTRACT = contract(CONTENTION_RECORD_PAYLOAD_COLUMNS, {
  occurrences: 1,
  hostLoad: null,
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
const BRIEF_INJECTION_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId machineId localId sessionId at source bytes lines cursors keylessCursors keylessIdleMaxMs overCap createdAt updatedAt',
)
const CONTEXT_REVIEW_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId machineId localId sessionId at intervalMs items flagged itemIds createdAt updatedAt',
)
const HOOK_EMISSION_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId machineId localId sessionId at event hook kind chars lines textHash createdAt updatedAt',
)
const REVIEW_FUNNEL_DECISION_RECORD_PAYLOAD_CONTRACT = contract(
  'id spaceId projectId projectName machineId localId surface taskKey branch headCommit patchId zeroContextPatchId pathSet policyVersion mode factsDigest facts stack verdict outcome sessionId recordedAt withheldFields createdAt updatedAt',
  {
    projectId: null,
    taskKey: null,
    zeroContextPatchId: null,
    stack: null,
    sessionId: null,
    withheldFields: null,
  },
)

export const OUTBOX_PAYLOAD_CONTRACTS = {
  run: RUN_RECORD_PAYLOAD_CONTRACT,
  score: SCORE_RECORD_PAYLOAD_CONTRACT,
  task_flow: TASK_FLOW_RECORD_PAYLOAD_CONTRACT,
  task_flow_stage: TASK_FLOW_STAGE_RECORD_PAYLOAD_CONTRACT,
  review: REVIEW_RECORD_PAYLOAD_CONTRACT,
  review_lens: REVIEW_LENS_RECORD_PAYLOAD_CONTRACT,
  review_finding: REVIEW_FINDING_RECORD_PAYLOAD_CONTRACT,
  review_read: REVIEW_READ_RECORD_PAYLOAD_CONTRACT,
  review_funnel_decision: REVIEW_FUNNEL_DECISION_RECORD_PAYLOAD_CONTRACT,
  release: RELEASE_RECORD_PAYLOAD_CONTRACT,
  landing: LANDING_RECORD_PAYLOAD_CONTRACT,
  landing_override: LANDING_OVERRIDE_RECORD_PAYLOAD_CONTRACT,
  landing_review_carry: LANDING_REVIEW_CARRY_RECORD_PAYLOAD_CONTRACT,
  landing_triage_snapshot: LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_CONTRACT,
  pull_request_ci: PULL_REQUEST_CI_RECORD_PAYLOAD_CONTRACT,
  contention: CONTENTION_RECORD_PAYLOAD_CONTRACT,
  test_flake: TEST_FLAKE_RECORD_PAYLOAD_CONTRACT,
  branch_disposal: BRANCH_DISPOSAL_RECORD_PAYLOAD_CONTRACT,
  brief_injection: BRIEF_INJECTION_RECORD_PAYLOAD_CONTRACT,
  context_review: CONTEXT_REVIEW_RECORD_PAYLOAD_CONTRACT,
  hook_emission: HOOK_EMISSION_RECORD_PAYLOAD_CONTRACT,
} as const
