// concern: hosted-local-sql-check
/** Check-owned exclusions for local SQL that names hosted tables. */

import { LOCAL_SQLITE_ADAPTER_PATH } from '../orchestrator/src/database/hosted-table-guard.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'

export const HOSTED_LOCAL_SQL_EXCLUSION_REASONS = [
  'outbox',
  'cache',
  'adoption',
  'backtest',
  'fixture',
  'migration',
  'local-only',
  'planned',
  'hosted-record',
  'passthrough',
] as const

type HostedLocalSqlExclusionReason = (typeof HOSTED_LOCAL_SQL_EXCLUSION_REASONS)[number]

type B2ReasonedSite = {
  file: string
  functionName: string
  expectedSites: number
  detail: string
}

const B2_LOCAL_ONLY_SITES: readonly B2ReasonedSite[] = [
  {
    file: 'hub/src/task-local-read.ts',
    functionName: 'listLocalTasks',
    expectedSites: 1,
    detail:
      'task.ts listTasks returns through listHostedTasks first; TaskReadPort.listLocal calls this local reader directly so default local project retirement can inspect the built-in spaceless project',
  },
  ...[
    ['lookupLocalTasks', 2],
    ['showLocalTask', 1],
  ].map(([functionName, expectedSites]) => ({
    file: 'hub/src/task-local-read.ts',
    functionName: String(functionName),
    expectedSites: Number(expectedSites),
    detail:
      'task.ts listTasks, lookupTasks, and readCurrentTask return through listHostedTasks, hostedLookupTasks, or showHostedTask before calling this local reader',
  })),
  ...[
    ['listLocalTaskDocuments', 1],
    ['getLocalTaskDocument', 1],
    ['assertLocalRoleAvailable', 1],
    ['createLocalTaskDocument', 3],
    ['applyHostedDocumentUpdateLocally', 2],
    ['updateTaskDocument', 3],
    ['deleteTaskDocument', 3],
  ].map(([functionName, expectedSites]) => ({
    file: 'hub/src/task-document.ts',
    functionName: String(functionName),
    expectedSites: Number(expectedSites),
    detail:
      'listTaskDocuments, getTaskDocument, and the document write operations return through resolveHostedTaskDocuments, resolveHostedTaskDocument, or their hosted write arm before calling this local helper',
  })),
  ...['taskDocumentIdentityByNumber', 'otherTaskDocumentIdentityByNumber'].map((functionName) => ({
    file: 'hub/src/identity/identity.ts',
    functionName,
    expectedSites: 1,
    detail:
      'task-document public readers return through their hosted document client before reaching this local identity helper',
  })),
  {
    file: 'hub/src/note-read.ts',
    functionName: 'listLocalFilteredRows',
    expectedSites: 1,
    detail:
      'listNotes and listSlimNotes return through their hosted list client before listLocalFilteredRows',
  },
  {
    file: 'hub/src/note.ts',
    functionName: 'noteRow',
    expectedSites: 1,
    detail:
      'noteRow callers are confined to local-authoritative arms after dropNote stopped calling it on the hosted path',
  },
  {
    file: 'hub/src/note.ts',
    functionName: 'mintLocalNoteNumber',
    expectedSites: 2,
    detail:
      'mintLocalNoteNumber is reached only by createLocalNoteRow in createNote local-authoritative handling',
  },
  {
    file: 'hub/src/note-read.ts',
    functionName: 'listNoteAcknowledgements',
    expectedSites: 1,
    detail:
      'listNoteAcknowledgements returns through its hosted-first branch before selecting local acknowledgements',
  },
  {
    file: 'hub/src/note-read.ts',
    functionName: 'localNoteAcknowledgementSightings',
    expectedSites: 1,
    detail:
      'acknowledgeNote calls localNoteAcknowledgementSightings only after its hosted write arm returns',
  },
  {
    file: 'hub/src/ingest/trackers.ts',
    functionName: 'localOpenTrackerTasks',
    expectedSites: 1,
    detail:
      'fetchTrackerTasks returns through listHostedTasks on a hosted install before calling localOpenTrackerTasks',
  },
  {
    file: 'hub/src/task.ts',
    functionName: 'mintLocalTaskKey',
    expectedSites: 1,
    detail: 'mintLocalTaskKey is reached only by createLocalTaskInTransaction local callers',
  },
  {
    file: 'hub/src/task.ts',
    functionName: 'createLocalTaskInTransaction',
    expectedSites: 4,
    detail:
      'createLocalTaskInTransaction is called by createTask and promoteNote only in their local-authoritative arms',
  },
  {
    file: 'hub/src/task.ts',
    functionName: 'localTaskInTransaction',
    expectedSites: 1,
    detail:
      'localTaskInTransaction callers attachLocalTaskEvidenceInTransaction and prepareNoteRelinkComments are reached only by promoteNote and relinkNote local arms',
  },
  {
    file: 'hub/src/task.ts',
    functionName: 'applyLocalTaskPatch',
    expectedSites: 3,
    detail:
      'applyLocalTaskPatch is called by setTaskBody and updateTask only after their hosted paths return',
  },
  {
    file: 'hub/src/task.ts',
    functionName: 'editableComment',
    expectedSites: 1,
    detail:
      'editableComment is called by editTaskComment and removeTaskComment after hosted returns',
  },
]

const B2_PLANNED_LOCAL_READ_SITES: readonly B2ReasonedSite[] = [
  ...[
    ['intervalsInWindow', 1],
    ['completedInWindow', 1],
    ['boardTasks', 1],
  ].map(([functionName, expectedSites]) => ({
    file: 'hub/src/query.ts',
    functionName: String(functionName),
    expectedSites: Number(expectedSites),
    detail: `hub query reporting calls ${String(functionName)} directly`,
  })),
  ...[
    ['uniqueTaskRecordIdForKey', 1],
    ['observedTaskKeyPrefixes', 1],
    ['taskIdentityCandidates', 1],
    ['taskByRecordId', 1],
  ].map(([functionName, expectedSites]) => ({
    file: 'hub/src/task-identity.ts',
    functionName: String(functionName),
    expectedSites: Number(expectedSites),
    detail: `task identity resolution reaches ${String(functionName)}`,
  })),
  {
    file: 'hub/src/task-record.ts',
    functionName: 'taskRecordFromRows',
    expectedSites: 1,
    detail: 'taskRecord calls taskRecordFromRows to attach local status history',
  },
  ...[
    ['deletionPlans', 1],
    ['retirementPlans', 1],
  ].map(([functionName, expectedSites]) => ({
    file: 'hub/src/ingest/tracker-hosted-collector.ts',
    functionName: String(functionName),
    expectedSites: Number(expectedSites),
    detail: `applyHostedCollectorPass calls ${String(functionName)}`,
  })),
  ...[
    ['retireLocalTrackerRows', 1],
    ['dropLocalTrackerRows', 1],
  ].map(([functionName, expectedSites]) => ({
    file: 'hub/src/ingest/tracker-local-collector.ts',
    functionName: String(functionName),
    expectedSites: Number(expectedSites),
    detail: `the local collector calls ${String(functionName)}`,
  })),
  ...[
    ['trackerIdentityRow', 3],
    ['trackerLabelAfterCollisionCheck', 1],
    ['plannedTrackerLabel', 1],
    ['refreshTrackerClaim', 2],
    ['recentIntervalsNeedingTracker', 1],
  ].map(([functionName, expectedSites]) => ({
    file: 'hub/src/ingest/trackers.ts',
    functionName: String(functionName),
    expectedSites: Number(expectedSites),
    detail:
      'tracker ingestion reaches synchronous connection helpers at trackers.ts:253, :280, :328, :499 and :874 under q7809(a)',
  })),
  ...[
    ['recordedSubjectRefs', 1],
    ['recordNoteDuplicateMerge', 1],
    ['recordNoteDuplicateDistinct', 1],
  ].map(([functionName, expectedSites]) => ({
    file: 'hub/src/note-duplicate-question.ts',
    functionName: String(functionName),
    expectedSites: Number(expectedSites),
    detail: `note duplicate handling reaches ${String(functionName)}`,
  })),
  {
    file: 'hub/src/note-staleness-store.ts',
    functionName: 'applyLocalStaleness',
    expectedSites: 2,
    detail: 'note staleness handling reaches applyLocalStaleness',
  },
  {
    file: 'hub/src/identity/identity.ts',
    functionName: 'resolveNoteIdentity',
    expectedSites: 1,
    detail:
      'note keep, same, promote, merge, and relink commands call note-cli reference, which refreshes the hosted note cache once on a local miss before resolveNoteReference calls resolveNoteIdentity',
  },
  {
    file: 'hub/src/identity/identity.ts',
    functionName: 'noteIdentityByNumber',
    expectedSites: 1,
    detail:
      'note keep, same, promote, merge, and relink commands call note-cli reference, which refreshes the hosted note cache once on a local miss before resolveNoteReference calls resolveNoteIdentity and noteIdentityByNumber',
  },
]

const DOC_REVISION_LOCAL_ONLY_SITES: readonly B2ReasonedSite[] = [
  {
    file: 'orchestrator/src/doc/doc-revision-store.ts',
    functionName: 'hasCanonImportHistory',
    expectedSites: 1,
    detail:
      'both callers are local-authoritative arms: authoritativeCanonImportHistory under applyRecordReadAuthority local handling, and localCanonImportResult in canon-import.ts under applyRecordWriteAuthority local handling',
  },
  {
    file: 'orchestrator/src/doc/doc-revision-store.ts',
    functionName: 'currentDocRevision',
    expectedSites: 1,
    detail:
      'doc-restore-state reaches this helper only through restoreReadState local-authoritative handling, while the hosted mirror calls commitHostedDocRestore without a local comparison',
  },
  {
    file: 'orchestrator/src/doc/doc-revision-store.ts',
    functionName: 'latestStoredDocAuthorSession',
    expectedSites: 1,
    detail:
      'resumeBriefAuthorSession calls this helper only when record authority is local, and context-service calls it only from sessionResumeBriefState local handling',
  },
  {
    file: 'orchestrator/src/doc/doc-revision-store.ts',
    functionName: 'listStoredDocRevisions',
    expectedSites: 2,
    detail:
      'doc-authoritative-read calls this helper only inside applyRecordReadAuthority local-authoritative history and revision-list handling',
  },
  {
    file: 'orchestrator/src/identity/doc-revision-identity.ts',
    functionName: 'resolveDocRevisionIdentifier',
    expectedSites: 2,
    detail:
      'resolveDocRevisionIdentifier confines both local revision lookups to applyRecordReadAuthority local-authoritative handling and returns or refuses identifiers in its hosted arm',
  },
]

const DOC_REVISION_PLANNED_SITES: readonly B2ReasonedSite[] = [
  {
    file: 'orchestrator/src/doc/doc-revision-store.ts',
    functionName: 'getStoredDocRevision',
    expectedSites: 3,
    detail:
      'the one doc_revision read serves filed ruling refs in commands/rulings.ts and mcp/mcp-operator-tools.ts that need revision.number, which the hosted record has no column for; the other two budgeted sites are subject reads that retain declared-cache classification; held for Shmuel Barkin ruling on a record revision-number column or ruling-ref format change, task DEV-2634',
  },
]

export type HostedLocalSqlAllowedFile = {
  pattern: RegExp
  functionName?: string
  reason?: HostedLocalSqlExclusionReason | string
  detail?: string
  expectedSites?: number
  reportOnly?: true
}

const REPORT_ONLY_ALLOWED_FILES: readonly {
  file: string
  reason: HostedLocalSqlExclusionReason
  expectedSites?: number
}[] = [
  { file: 'orchestrator/src/board/board-push-service.ts', reason: 'outbox', expectedSites: 5 },
  { file: 'orchestrator/src/board/board-adoption.ts', reason: 'adoption', expectedSites: 6 },
  { file: 'orchestrator/src/typed-question/typed-question-backtest.ts', reason: 'backtest' },
  { file: 'orchestrator/src/typed-question/typed-question-report.ts', reason: 'backtest' },
  { file: 'hub/src/task-push.ts', reason: 'outbox' },
  { file: 'hub/src/note-push.ts', reason: 'outbox' },
  { file: 'hub/src/task-cache.ts', reason: 'cache' },
  { file: 'hub/src/note-cache.ts', reason: 'cache' },
  { file: 'hub/src/hosted-change-cache.ts', reason: 'cache' },
  { file: 'hub/src/pending-hosted-edit.ts', reason: 'cache' },
  { file: 'hub/src/task-document-hosted.ts', reason: 'cache' },
  { file: 'hub/src/task-adoption.ts', reason: 'adoption' },
  { file: 'hub/src/task-document-demotion.ts', reason: 'adoption' },
  { file: 'hub/src/note-duplicate-backtest.ts', reason: 'backtest' },
  { file: 'hub/src/typed-question-report.ts', reason: 'backtest' },
  { file: 'hub/src/fixture-question-reclaim.ts', reason: 'fixture' },
]

export const HOSTED_LOCAL_SQL_ALLOWED_FILES: readonly HostedLocalSqlAllowedFile[] = [
  {
    pattern: new RegExp(LOCAL_SQLITE_ADAPTER_PATH),
    reason: 'local-only',
    detail:
      'SQLite question and task-flow adapters are selected only by their store selectors on local installs',
  },
  {
    pattern:
      /^orchestrator\/src\/database\/(?:migrations(?:-[^/]+)?|[^/]+-migration-preflight)\.ts$/,
    reason: 'migration',
    detail: 'SQLite migration preflights operate on the unguarded migration-step handle',
  },
  {
    pattern:
      /^orchestrator\/src\/record\/(?:record-context-items|record-question-(?:number|read|write)|record-task-flow(?:-write)?)\.ts$/,
    reason: 'hosted-record',
    detail:
      'Postgres record modules operate on the hosted record rather than a guarded SQLite handle',
  },
  {
    pattern: /^orchestrator\/(?:test\/|.*\.fixture\.ts$)/,
    reason: 'fixture',
    detail: 'Fixtures own isolated stores and never receive the production guarded handle',
  },
  {
    pattern: /^orchestrator\/src\/database\/entity-number\.ts$/,
    reason: 'local-only',
    detail: 'The local identity-number adapter is reached only for local stores',
    expectedSites: 1,
  },
  {
    pattern: /^orchestrator\/src\/database\/slow-statements\.ts$/,
    reason: 'passthrough',
    detail:
      'SQL timing instrumentation transparently forwards dynamic statements to the handle it wraps; the runtime hosted-table guard remains the backstop',
    expectedSites: 2,
  },
  {
    pattern: /^orchestrator\/src\/database\/db\.ts$/,
    reason: 'local-only',
    detail:
      'Local connection write probes run before store-hooks wraps the handle and constrain dynamic table names to WRITE_PROBE_TABLE_PREFIX',
    expectedSites: 2,
  },
  {
    pattern: /^orchestrator\/src\/database\/hosted-row-release\.ts$/,
    reason: 'adoption',
    detail: 'Verifies and releases local copies on the migration-step handle',
    expectedSites: 15,
  },
  {
    pattern: /^orchestrator\/src\/record\/(?:record-board-claims|record-projects|record-sync)\.ts$/,
    reason: 'hosted-record',
    detail:
      'Postgres record modules operate on the hosted record rather than a guarded SQLite handle',
  },
  {
    pattern: /^orchestrator\/src\/record\/outbox-prune\.ts$/,
    reason: 'outbox',
    detail: 'Record synchronization prunes the machine-local outbox',
  },
  {
    pattern: /^orchestrator\/src\/record\/record-cache-lens\.ts$/,
    reason: 'cache',
    detail: 'Record synchronization queries machine-local cache tables',
  },
  {
    pattern: /^orchestrator\/src\/record\/record-history-upload\.ts$/,
    reason: 'adoption',
    detail:
      'History upload local hosted-table SQL requires the owned maintenance handle before hosted release',
    expectedSites: 7,
  },
  {
    pattern: /^orchestrator\/src\/record\/record-hosted-row-presence\.ts$/,
    reason: 'adoption',
    detail: 'Shared maintenance reader collects local hosted-history ids before presence checks',
    expectedSites: 7,
  },
  {
    pattern: /^orchestrator\/src\/record\/record-cache-workflow\.ts$/,
    reason: 'cache',
    detail:
      'Workflow record-cache SQL is selected only when hostedRecordOwnsHostedTables(local) is false',
    expectedSites: 1,
  },
  {
    pattern: /^orchestrator\/src\/session-report\/session-report-adapter\.ts$/,
    reason: 'local-only',
    detail:
      'Workflow-cursor report SQL is selected only when hostedRecordOwnsHostedTables(database) is false',
    expectedSites: 1,
  },
  {
    pattern: /^orchestrator\/src\/board\/board-claim-cursor-binding\.ts$/,
    reason: 'local-only',
    detail:
      'Cursor-bound local claim liveness is selected only when hostedRecordOwnsHostedTables(database) is false',
    expectedSites: 1,
  },
  {
    pattern: /^orchestrator\/src\/doc\/doc-read-store\.ts$/,
    reason: 'local-only',
    detail: 'The local document read adapter builds SQL only for machine-local document tables',
    expectedSites: 1,
  },
  ...DOC_REVISION_LOCAL_ONLY_SITES.map(({ file, functionName, expectedSites, detail }) => ({
    pattern: new RegExp(`^${file.replaceAll('.', '\\.')}$`),
    functionName,
    reason: 'local-only' as const,
    detail,
    expectedSites,
    reportOnly: true as const,
  })),
  ...DOC_REVISION_PLANNED_SITES.map(({ file, functionName, expectedSites, detail }) => ({
    pattern: new RegExp(`^${file.replaceAll('.', '\\.')}$`),
    functionName,
    reason: 'planned' as const,
    detail,
    expectedSites,
    reportOnly: true as const,
  })),
  ...B2_LOCAL_ONLY_SITES.map(({ file, functionName, expectedSites, detail }) => ({
    pattern: new RegExp(`^${file.replaceAll('.', '\\.')}$`),
    functionName,
    reason: 'local-only' as const,
    detail,
    expectedSites,
    reportOnly: true as const,
  })),
  ...B2_PLANNED_LOCAL_READ_SITES.map(({ file, functionName, expectedSites, detail }) => ({
    pattern: new RegExp(`^${file.replaceAll('.', '\\.')}$`),
    functionName,
    reason: 'planned' as const,
    detail: `${detail}; planned by project/${PLATFORM_SLUG}/plan-dev-2608-b3-local-task-reads`,
    expectedSites,
    reportOnly: true as const,
  })),
  ...REPORT_ONLY_ALLOWED_FILES.map(({ file, reason, expectedSites }) => ({
    pattern: new RegExp(`^${file.replaceAll('.', '\\.')}$`),
    reason,
    detail: `${reason} path declared by DEV-2608`,
    ...(expectedSites === undefined ? {} : { expectedSites: Number(expectedSites) }),
    reportOnly: true as const,
  })),
] as const
