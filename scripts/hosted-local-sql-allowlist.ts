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
  'hosted-record',
  'passthrough',
] as const

type HostedLocalSqlExclusionReason = (typeof HOSTED_LOCAL_SQL_EXCLUSION_REASONS)[number]

const B2_LOCAL_ONLY_SITES: readonly { file: string; line: number; detail: string }[] = [
  ...[29, 43, 53, 72].map((line) => ({
    file: 'hub/src/task-local-read.ts',
    line,
    detail:
      'task.ts listTasks, lookupTasks, and readCurrentTask return through listHostedTasks, hostedLookupTasks, or showHostedTask before calling this local reader',
  })),
  ...[73, 84, 136, 174, 303, 417, 499].map((line) => ({
    file: 'hub/src/task-document.ts',
    line,
    detail:
      'listTaskDocuments, getTaskDocument, and the document write operations return through resolveHostedTaskDocuments, resolveHostedTaskDocument, or their hosted write arm before calling this local helper',
  })),
  ...[33, 64, 78, 93].map((line) => ({
    file: 'hub/src/identity/identity.ts',
    line,
    detail:
      'note and task-document public readers return through their hosted note or hosted document client before reaching this local identity helper',
  })),
  {
    file: 'hub/src/note-read.ts',
    line: 97,
    detail:
      'listNotes and listSlimNotes return through their hosted list client before listLocalFilteredRows',
  },
  {
    file: 'hub/src/note.ts',
    line: 160,
    detail:
      'noteRow callers are confined to local-authoritative arms after dropNote stopped calling it on the hosted path',
  },
  {
    file: 'hub/src/note.ts',
    line: 170,
    detail:
      'mintLocalNoteNumber is reached only by createLocalNoteRow in createNote local-authoritative handling',
  },
  {
    file: 'hub/src/note.ts',
    line: 800,
    detail:
      'staleNotes selects this local acknowledgement query only when hostedWriteMode is not hosted-configured',
  },
]

const B2_PLANNED_LOCAL_READ_SITES: readonly { file: string; line: number }[] = [
  ...[33, 101, 324].map((line) => ({ file: 'hub/src/query.ts', line })),
  ...[44, 67, 92, 199].map((line) => ({ file: 'hub/src/task-identity.ts', line })),
  { file: 'hub/src/task-record.ts', line: 83 },
  ...[114, 141].map((line) => ({ file: 'hub/src/ingest/tracker-hosted-collector.ts', line })),
  ...[29, 72].map((line) => ({ file: 'hub/src/ingest/tracker-local-collector.ts', line })),
  ...[257, 265, 273, 290, 332, 503, 508, 695, 877].map((line) => ({
    file: 'hub/src/ingest/trackers.ts',
    line,
  })),
  ...[122, 217, 237].map((line) => ({ file: 'hub/src/note-duplicate-question.ts', line })),
  { file: 'hub/src/note-staleness-store.ts', line: 80 },
]

export type HostedLocalSqlAllowedFile = {
  pattern: RegExp
  line?: number
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
  {
    pattern: /^hub\/src\/task\.ts$/,
    line: 164,
    reason: 'local-only',
    detail: 'mintLocalTaskKey is reached only by createLocalTaskInTransaction local callers',
    expectedSites: 1,
    reportOnly: true,
  },
  ...B2_LOCAL_ONLY_SITES.map(({ file, line, detail }) => ({
    pattern: new RegExp(`^${file.replaceAll('.', '\\.')}$`),
    line,
    reason: 'local-only' as const,
    detail,
    expectedSites: 1,
    reportOnly: true as const,
  })),
  ...B2_PLANNED_LOCAL_READ_SITES.map(({ file, line }) => ({
    pattern: new RegExp(`^${file.replaceAll('.', '\\.')}$`),
    line,
    reason: 'local-only' as const,
    detail: `hosted read is planned by project/${PLATFORM_SLUG}/plan-dev-2608-b3-local-task-reads; the B2 refusal remains active for every unplanned site`,
    expectedSites: 1,
    reportOnly: true as const,
  })),
  ...([248, 310] as const).map((line) => ({
    pattern: /^hub\/src\/task\.ts$/,
    line,
    reason: 'local-only' as const,
    detail:
      'createLocalTaskInTransaction is called by createTask and promoteNote only in their local-authoritative arms',
    expectedSites: 1,
    reportOnly: true as const,
  })),
  {
    pattern: /^hub\/src\/task\.ts$/,
    line: 362,
    reason: 'local-only',
    detail:
      'localTaskInTransaction callers attachLocalTaskEvidenceInTransaction and prepareNoteRelinkComments are reached only by promoteNote and relinkNote local arms',
    expectedSites: 1,
    reportOnly: true,
  },
  ...([657, 690] as const).map((line) => ({
    pattern: /^hub\/src\/task\.ts$/,
    line,
    reason: 'local-only' as const,
    detail:
      'applyLocalTaskPatch is called by setTaskBody and updateTask only after their hosted paths return',
    expectedSites: 1,
    reportOnly: true as const,
  })),
  {
    pattern: /^hub\/src\/task\.ts$/,
    line: 890,
    reason: 'local-only',
    detail:
      'editableComment is called by editTaskComment and removeTaskComment after hosted returns',
    expectedSites: 1,
    reportOnly: true,
  },
  ...REPORT_ONLY_ALLOWED_FILES.map(({ file, reason, expectedSites }) => ({
    pattern: new RegExp(`^${file.replaceAll('.', '\\.')}$`),
    reason,
    detail: `${reason} path declared by DEV-2608`,
    ...(expectedSites === undefined ? {} : { expectedSites: Number(expectedSites) }),
    reportOnly: true as const,
  })),
] as const
