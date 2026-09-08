import { sql } from 'drizzle-orm'
import {
  check, foreignKey, index, integer, primaryKey, real, sqliteTable, text, unique, uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { DOC_SCOPES, DOC_SCOPE_SUBJECT_KIND } from '../../shared/docs.ts'
import {
  DELIVERY, FIDELITY, MONITOR_SEVERITY, QUALITY, REVIEW_COVERAGE, REVIEW_LIMITS,
  REVIEW_OVERLAP, REVIEW_REPRODUCED, REVIEW_SEVERITY, RUN_MUTATION_ACTIONS,
} from './db.ts'
import { EVENT_KINDS, RESOURCE_KINDS } from './contention.ts'

const values = (items: readonly string[]) => sql.raw(items.map((item) => `'${item}'`).join(','))
const subjectlessScopes = DOC_SCOPES.filter((scope) => DOC_SCOPE_SUBJECT_KIND[scope] === null)
const subjectScopes = DOC_SCOPES.filter((scope) => DOC_SCOPE_SUBJECT_KIND[scope] !== null)
const id = () => integer('id').primaryKey({ autoIncrement: true })

export const agent = sqliteTable('agent', {
  name: text().primaryKey(), harness: text().notNull(), backend: text(), model: text().notNull(),
  baseUrl: text('base_url'), transport: text().notNull().default('cli'), caps: text().notNull(),
  billing: text().notNull(), enabled: integer().notNull().default(1),
  disabledReason: text('disabled_reason'), probedAt: text('probed_at'), probeResult: text('probe_result'),
}, (t) => [
  check('agent_transport_check', sql`${t.transport} in ('cli','acp')`),
  check('agent_billing_check', sql`${t.billing} in ('subscription','free','local','metered','unknown')`),
  check('agent_enabled_check', sql`${t.enabled} in (0,1)`),
  check('agent_caps_json_check', sql`json_valid(${t.caps})`),
  check('agent_probe_result_json_check', sql`${t.probeResult} is null or json_valid(${t.probeResult})`),
  check('agent_disabled_reason_check', sql`(${t.enabled} = 1 and ${t.disabledReason} is null) or (${t.enabled} = 0 and length(trim(${t.disabledReason})) > 0)`),
])

export const run = sqliteTable('run', {
  id: id(), startedAt: text('started_at').notNull(), agent: text().notNull(), job: text().notNull(),
  /** @deprecated One-release mirror; use projectId. */
  repo: text(), projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }),
  cwd: text(), promptSha: text('prompt_sha').notNull(), specSha: text('spec_sha'),
  promptBytes: integer('prompt_bytes').notNull(),
  promptHead: text('prompt_head').notNull(), label: text(), lens: text(), latencyMs: integer('latency_ms'),
  exitCode: integer('exit_code'), outputBytes: integer('output_bytes'), outputPath: text('output_path'),
  promptPath: text('prompt_path'), vendorTokens: integer('vendor_tokens'), vendorCostUsd: real('vendor_cost_usd'),
  probe: integer().notNull().default(0), failureKind: text('failure_kind'),
  status: text().notNull().default('running'), error: text(), pid: integer(), sessionId: text('session_id'),
  retryOf: integer('retry_of'), launchCwd: text('launch_cwd'), launchSeed: text('launch_seed'),
  launchKey: text('launch_key'), launchBase: text('launch_base'), noFailover: integer('no_failover').notNull().default(0),
  automaticFailover: integer('automatic_failover').notNull().default(0), routeReason: text('route_reason'),
  sandbox: text(), branch: text(), branchKept: text('branch_kept'), branchKeptTip: text('branch_kept_tip'),
  worktree: text(), worktreeSource: text('worktree_source'), vendorSession: text('vendor_session'),
  baseCommit: text('base_commit'), carryHappened: integer('carry_happened'), carryBaseCommit: text('carry_base_commit'),
  carryTrackedPaths: text('carry_tracked_paths'), carryUntrackedPaths: text('carry_untracked_paths'),
  parentRunId: integer('parent_run_id').references((): any => run.id), turn: integer().notNull().default(1),
  filesChanged: integer('files_changed'), changedPaths: text('changed_paths'), linesAdded: integer('lines_added'),
  linesRemoved: integer('lines_removed'), testsRan: integer('tests_ran'), testsPassed: integer('tests_passed'),
  deviations: integer(), escalations: integer(), stack: text(), model: text(), runToken: text('run_token'),
  evidenceExcluded: text('evidence_excluded'), outsideWorktreeWrites: text('outside_worktree_writes'),
  inputTree: text('input_tree'), headCommit: text('head_commit'), reviewRef: text('review_ref'),
  agentPid: integer('agent_pid'), mcp: integer(), mcpServer: text('mcp_server'), mcpConnected: integer('mcp_connected'),
  mcpError: text('mcp_error'), mcpTrustGranted: integer('mcp_trust_granted'), mcpTrustPath: text('mcp_trust_path'),
  schemaPath: text('schema_path'), docsInjected: integer('docs_injected'), docRevisions: text('doc_revisions'), canonSha: text('canon_sha'),
  transport: text(),
  preConfinement: text('pre_confinement'),
  keepTree: integer('keep_tree').notNull().default(0),
  lastEventAt: text('last_event_at'),
  mintedBranch: text('minted_branch'),
  unreconciled: integer().notNull().default(0),
}, (t) => [
  check('run_status_check', sql`${t.status} in ('running','ok','failed','stale','asking','stopped')`),
  check('run_unreconciled_check', sql`${t.unreconciled} in (0,1)`),
  check('run_sandbox_check', sql`${t.sandbox} is null or ${t.sandbox} in ('host','srt')`),
  check('run_worktree_source_check', sql`${t.worktreeSource} is null or ${t.worktreeSource} in ('recipe','git','readonly_recipe')`),
  check('run_transport_check', sql`${t.transport} is null or ${t.transport} in ('cli','acp')`),
  index('run_job_agent').on(t.job, t.agent),
])

export const score = sqliteTable('score', {
  id: id(), runId: integer('run_id').notNull().references(() => run.id, { onDelete: 'cascade' }),
  delivery: text().notNull(), quality: text(), fidelity: text(), note: text(), scoredAt: text('scored_at').notNull(),
  scoredBy: text('scored_by').notNull().default('claude'),
}, (t) => [
  check('score_delivery_check', sql`${t.delivery} in (${values(DELIVERY)})`),
  check('score_quality_check', sql`${t.quality} in (${values(QUALITY)})`),
  check('score_fidelity_check', sql`${t.fidelity} is null or ${t.fidelity} in (${values(FIDELITY)})`),
  check('score_delivery_quality_check', sql`(${t.delivery} = 'none') = (${t.quality} is null)`),
  index('score_run').on(t.runId), uniqueIndex('score_one_per_run').on(t.runId),
])

const docAddressChecks = <T extends { scope: any; subject: any; slug: any }>(t: T) => [
  check('scope_check', sql`${t.scope} in (${values(DOC_SCOPES)})`),
  check('slug_check', sql`length(${t.slug}) <= 64 and ${t.slug} glob '[a-z0-9]*' and ${t.slug} not glob '*[^a-z0-9-]*'`),
  check('subject_check', sql`(${t.scope} in (${values(subjectlessScopes)}) and ${t.subject} is null) or (${t.scope} in (${values(subjectScopes)}) and ${t.subject} is not null)`),
]

// migrations/0000_bright_sleepwalker.sql owns doc_address: Drizzle Kit 0.31.10 cannot express
// COALESCE in an index without emitting malformed SQL.
export const doc = sqliteTable('doc', {
  id: integer().primaryKey(), scope: text().notNull(), /** @deprecated Project-scope mirror; use projectId. */ subject: text(), slug: text().notNull(), title: text().notNull(),
  projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }),
  body: text().notNull(), delivery: text().notNull().default('inject'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, (t) => [
  ...docAddressChecks(t), check('doc_delivery_check', sql`${t.delivery} in ('inject','demand')`),
  unique('doc_scope_subject_slug_unique').on(t.scope, t.subject, t.slug), index('doc_scope_subject').on(t.scope, t.subject),
])

export const docRevision = sqliteTable('doc_revision', {
  id: integer().primaryKey(), docId: integer('doc_id').notNull(), scope: text().notNull(), /** @deprecated Project-scope mirror; use projectId. */ subject: text(), slug: text().notNull(),
  projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }),
  op: text().notNull(), title: text().notNull(), body: text().notNull(), delivery: text().notNull().default('inject'),
  author: text().notNull(), reason: text().notNull(), sessionId: text('session_id'), at: text().notNull(),
}, (t) => [
  ...docAddressChecks(t), check('doc_revision_op_check', sql`${t.op} in ('create','set','consume','delete','restore','import','backfill')`),
  check('doc_revision_delivery_check', sql`${t.delivery} in ('inject','demand')`),
  check('doc_revision_author_check', sql`length(trim(${t.author})) > 0`), check('doc_revision_reason_check', sql`length(trim(${t.reason})) > 0`),
  index('doc_revision_doc').on(t.docId, t.id), index('doc_revision_address').on(t.scope, t.subject, t.slug, t.id),
])

// migrations/0000_bright_sleepwalker.sql owns canon_pack_address: Drizzle Kit 0.31.10 cannot express
// COALESCE in an index without emitting malformed SQL.
export const canonPack = sqliteTable('canon_pack', {
  id: integer().primaryKey(), job: text().notNull(), /** @deprecated Use projectId. */ project: text(),
  projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }), sha256: text().notNull(), bytes: integer().notNull(),
  docCount: integer('doc_count').notNull(), docRevisions: text('doc_revisions').notNull(), compiledAt: text('compiled_at').notNull(), findings: integer().notNull(),
}, (t) => [unique('canon_pack_job_project_unique').on(t.job, t.project)])

export const canonEval = sqliteTable('canon_eval', {
  id: id(), slug: text().notNull(), runId: integer('run_id').notNull().references(() => run.id), canonSha: text('canon_sha').notNull(),
  agent: text().notNull(), model: text(), pass: integer().notNull(), why: text().notNull(), at: text().notNull(),
})

export const runMutationAudit = sqliteTable('run_mutation_audit', {
  runId: integer('run_id').notNull().references(() => run.id), rootId: integer('root_id').notNull().references(() => run.id),
  action: text().notNull(), actorSession: text('actor_session'), at: text().notNull(), reason: text(),
}, (t) => [check('run_mutation_action_check', sql`${t.action} in (${values(RUN_MUTATION_ACTIONS)})`),
  check('run_mutation_actor_check', sql`${t.actorSession} is null or length(${t.actorSession}) > 0`), index('run_mutation_audit_root').on(t.rootId)])

export const metric = sqliteTable('metric', {
  day: text().primaryKey(), claudeTokens: integer('claude_tokens').notNull(), cacheRead: integer('cache_read').notNull(),
  messages: integer().notNull(), tasks: integer().notNull(), canonTokens: integer('canon_tokens').notNull().default(0),
  otherTokens: integer('other_tokens').notNull().default(0), commits: integer().notNull().default(0), files: integer().notNull().default(0),
  linesProduct: integer('lines_product').notNull().default(0), linesTest: integer('lines_test').notNull().default(0),
  linesDocs: integer('lines_docs').notNull().default(0), linesConfig: integer('lines_config').notNull().default(0),
  linesGenerated: integer('lines_generated').notNull().default(0), collectedAt: text('collected_at').notNull(),
})

export const spawn = sqliteTable('spawn', {
  id: id(), at: text().notNull(), sessionId: text('session_id'), cwd: text(), event: text(), subagentType: text('subagent_type'),
  description: text(), promptBytes: integer('prompt_bytes'), decision: text().notNull(), why: text().notNull(),
}, (t) => [index('spawn_at').on(t.at)])
export const sessionSeen = sqliteTable('session_seen', { sessionId: text('session_id').primaryKey(), lastSeen: text('last_seen').notNull() })

export const duel = sqliteTable('duel', {
  id: id(), job: text().notNull(), winnerRunId: integer('winner_run_id').notNull().references(() => run.id, { onDelete: 'cascade' }),
  loserRunId: integer('loser_run_id').notNull().references(() => run.id, { onDelete: 'cascade' }), sessionId: text('session_id'), at: text().notNull(),
}, (t) => [check('duel_distinct_check', sql`${t.winnerRunId} <> ${t.loserRunId}`), unique('duel_pair_unique').on(t.winnerRunId, t.loserRunId), index('duel_job').on(t.job)])

export const comparedPair = sqliteTable('compared_pair', {
  runAId: integer('run_a_id').notNull().references(() => run.id, { onDelete: 'cascade' }),
  runBId: integer('run_b_id').notNull().references(() => run.id, { onDelete: 'cascade' }), comparedAt: text('compared_at').notNull(),
}, (t) => [primaryKey({ columns: [t.runAId, t.runBId] }), check('compared_pair_order_check', sql`${t.runAId} < ${t.runBId}`)])

export const calibration = sqliteTable('calibration', {
  id: id(), runId: integer('run_id').notNull().references(() => run.id, { onDelete: 'cascade' }), delivery: text().notNull(),
  quality: text(), fidelity: text(), at: text().notNull(), sessionId: text('session_id'),
}, (t) => [check('calibration_delivery_check', sql`${t.delivery} in (${values(DELIVERY)})`), check('calibration_quality_check', sql`${t.quality} in (${values(QUALITY)})`),
  check('calibration_fidelity_check', sql`${t.fidelity} is null or ${t.fidelity} in (${values(FIDELITY)})`),
  check('calibration_delivery_quality_check', sql`(${t.delivery} = 'none') = (${t.quality} is null)`)])

export const question = sqliteTable('question', {
  id: id(), runId: integer('run_id').notNull().references(() => run.id, { onDelete: 'cascade' }), askedAt: text('asked_at').notNull(),
  question: text().notNull(), options: text(), recommendation: text(), why: text(), answer: text(), answeredAt: text('answered_at'),
  answeredBy: text('answered_by'), deliveryPendingAt: text('delivery_pending_at'),
}, (t) => [index('question_run').on(t.runId), index('question_open').on(t.answeredAt).where(sql`${t.answeredAt} is null`)])

export const project = sqliteTable('project', {
  id: id(), name: text().notNull().unique(), path: text().notNull(), stack: text(), canon: integer().notNull().default(1), settings: text(),
})

export const blocker = sqliteTable('blocker', {
  id: id(), runId: integer('run_id').notNull().references(() => run.id, { onDelete: 'cascade' }), at: text().notNull(),
  what: text().notNull(), why: text(), impact: text(), source: text().notNull(), kind: text(),
}, (t) => [check('blocker_source_check', sql`${t.source} in ('declared','detected')`), index('blocker_run').on(t.runId), index('blocker_kind').on(t.kind, t.at)])

export const review = sqliteTable('review', {
  id: id(), recordedAt: text('recorded_at').notNull(), completedAt: text('completed_at'), tier: integer(), tierRisk: integer('tier_risk'),
  tierSize: integer('tier_size'), tierReasons: text('tier_reasons'), tierReason: text('tier_reason'),
  projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }),
})

export const reviewLens = sqliteTable('review_lens', {
  id: id(), reviewId: integer('review_id').notNull().references(() => review.id, { onDelete: 'cascade' }),
  runId: integer('run_id').notNull().unique().references(() => run.id, { onDelete: 'cascade' }), lens: text().notNull(), agent: text().notNull(),
  model: text(), treeInspected: text('tree_inspected'), reviewedTree: text('reviewed_tree'), standardsRead: text('standards_read').notNull(),
  filesCovered: text('files_covered').notNull(), commandsRun: text('commands_run').notNull(), couldNotVerify: text('could_not_verify').notNull(),
  reproduced: text(), coverage: text(), limits: text(), overlap: text(),
}, (t) => [
  check('review_lens_reproduced_check', sql`${t.reproduced} is null or ${t.reproduced} in (${values(REVIEW_REPRODUCED)})`),
  check('review_lens_coverage_check', sql`${t.coverage} is null or ${t.coverage} in (${values(REVIEW_COVERAGE)})`),
  check('review_lens_limits_check', sql`${t.limits} is null or ${t.limits} in (${values(REVIEW_LIMITS)})`),
  check('review_lens_overlap_check', sql`${t.overlap} is null or ${t.overlap} in (${values(REVIEW_OVERLAP)})`),
  index('review_calibration').on(t.lens, t.agent, t.model, t.reviewId),
])

export const reviewFinding = sqliteTable('review_finding', {
  id: id(), reviewId: integer('review_id').notNull().references(() => review.id, { onDelete: 'cascade' }),
  reviewLensId: integer('review_lens_id').notNull().references(() => reviewLens.id, { onDelete: 'cascade' }), ordinal: integer().notNull(),
  severity: text().notNull(), location: text().notNull(), evidence: text().notNull(), proposedCorrection: text('proposed_correction').notNull(),
  disposition: text(), rejectionCategory: text('rejection_category'), triagedSeverity: text('triaged_severity'), triagedAt: text('triaged_at'),
}, (t) => [unique('review_finding_review_ordinal_unique').on(t.reviewId, t.ordinal),
  check('review_finding_disposition_check', sql`${t.disposition} is null or ${t.disposition} in ('accepted','modified','rejected','skipped')`),
  check('review_finding_severity_check', sql`${t.triagedSeverity} is null or ${t.triagedSeverity} in (${values(REVIEW_SEVERITY)})`),
  check('review_finding_rejection_check', sql`${t.disposition} = 'rejected' or ${t.rejectionCategory} is null`)])

export const runMessage = sqliteTable('run_message', {
  id: id(), direction: text().notNull(), rootRunId: integer('root_run_id').notNull().references(() => run.id, { onDelete: 'cascade' }),
  runId: integer('run_id').notNull().references(() => run.id, { onDelete: 'cascade' }), senderSession: text('sender_session'), body: text().notNull(),
  createdAt: text('created_at').notNull(), readAt: text('read_at'), readBy: text('read_by'), delivery: text().notNull(),
}, (t) => [check('run_message_direction_check', sql`${t.direction} in ('to_worker','from_worker')`), check('run_message_body_check', sql`length(trim(${t.body})) > 0`),
  check('run_message_delivery_check', sql`${t.delivery} in ('architect_cli','worker_tool')`), index('run_message_root').on(t.rootRunId, t.id),
  index('run_message_unread').on(t.rootRunId, t.direction, t.readAt).where(sql`${t.readAt} is null`)])

export const monitorInvocation = sqliteTable('monitor_invocation', {
  id: id(), startedAt: text('started_at').notNull(), finishedAt: text('finished_at'), trigger: text().notNull(), findings: integer(), errors: integer(),
}, (t) => [check('monitor_invocation_trigger_check', sql`${t.trigger} in ('invoked','backstop')`)])

export const monitorCondition = sqliteTable('monitor_condition', {
  id: id(), invocationId: integer('invocation_id').notNull().references(() => monitorInvocation.id, { onDelete: 'cascade' }), kind: text().notNull(),
  subject: text().notNull(), conditionSince: text('condition_since'), ageMs: integer('age_ms'), detail: text().notNull(), action: text().notNull(),
  issueKey: text('issue_key'), severity: text(),
}, (t) => [check('monitor_condition_severity_check', sql`${t.severity} is null or ${t.severity} in (${values(MONITOR_SEVERITY)})`),
  unique('monitor_condition_invocation_kind_subject_unique').on(t.invocationId, t.kind, t.subject), index('monitor_condition_kind').on(t.kind, t.invocationId)])

export const schemaMeta = sqliteTable('schema_meta', { key: text().primaryKey(), value: text().notNull() })

export const workflow = sqliteTable('workflow', { id: id(), slug: text().notNull().unique(), createdAt: text('created_at').notNull() })
export const workflowVersion = sqliteTable('workflow_version', {
  id: id(), workflowId: integer('workflow_id').notNull().references(() => workflow.id, { onDelete: 'cascade' }), n: integer().notNull(), status: text().notNull(),
  definition: text().notNull(), author: text().notNull(), reason: text().notNull(), createdAt: text('created_at').notNull(), promotedAt: text('promoted_at'), retiredAt: text('retired_at'),
}, (t) => [check('workflow_version_status_check', sql`${t.status} in ('draft','production','retired')`), check('workflow_version_author_check', sql`length(trim(${t.author})) > 0`),
  check('workflow_version_reason_check', sql`length(trim(${t.reason})) > 0`), unique('workflow_version_workflow_n_unique').on(t.workflowId, t.n),
  uniqueIndex('workflow_one_production').on(t.workflowId).where(sql`${t.status} = 'production'`), index('workflow_version_workflow').on(t.workflowId, t.n)])
export const workflowEvent = sqliteTable('workflow_event', {
  id: id(), workflowId: integer('workflow_id').notNull(), versionN: integer('version_n').notNull(), event: text().notNull(),
  author: text().notNull(), reason: text().notNull(), sessionId: text('session_id'), at: text().notNull(),
}, (t) => [check('workflow_event_event_check', sql`${t.event} in ('set','fork','import','promote','retire')`), check('workflow_event_author_check', sql`length(trim(${t.author})) > 0`),
  check('workflow_event_reason_check', sql`length(trim(${t.reason})) > 0`), foreignKey({ columns: [t.workflowId, t.versionN], foreignColumns: [workflowVersion.workflowId, workflowVersion.n] }),
  index('workflow_event_version').on(t.workflowId, t.versionN, t.id)])

export const lens = sqliteTable('lens', {
  id: text().primaryKey(), title: text().notNull(), question: text().notNull(), excludes: text().notNull(),
  slots: text().notNull(), version: integer().notNull(), enabled: integer().notNull().default(1),
}, (t) => [check('lens_version_check', sql`${t.version} > 0`), check('lens_enabled_check', sql`${t.enabled} in (0,1)`)])
export const lensRevision = sqliteTable('lens_revision', {
  id: id(), lensId: text('lens_id').notNull().references(() => lens.id, { onDelete: 'cascade' }), version: integer().notNull(),
  priorBody: text('prior_body').notNull(), reason: text().notNull(), sessionId: text('session_id'), at: text().notNull(),
}, (t) => [unique('lens_revision_lens_version_unique').on(t.lensId, t.version),
  check('lens_revision_reason_check', sql`length(trim(${t.reason})) > 0`)])
export const lensProfile = sqliteTable('lens_profile', {
  id: id(), lensId: text('lens_id').notNull().references(() => lens.id, { onDelete: 'cascade' }),
  axis: text().notNull(), name: text().notNull(), version: integer().notNull(), body: text().notNull(), enabled: integer().notNull().default(1),
}, (t) => [check('lens_profile_axis_check', sql`${t.axis} in ('framework','architecture')`),
  check('lens_profile_version_check', sql`${t.version} > 0`), check('lens_profile_enabled_check', sql`${t.enabled} in (0,1)`),
  unique('lens_profile_lens_axis_name_unique').on(t.lensId, t.axis, t.name)])
export const lensProfileRevision = sqliteTable('lens_profile_revision', {
  id: id(), profileId: integer('profile_id').notNull().references(() => lensProfile.id, { onDelete: 'cascade' }),
  version: integer().notNull(), priorBody: text('prior_body').notNull(), reason: text().notNull(), sessionId: text('session_id'), at: text().notNull(),
}, (t) => [unique('lens_profile_revision_profile_version_unique').on(t.profileId, t.version),
  check('lens_profile_revision_reason_check', sql`length(trim(${t.reason})) > 0`)])
export const projectLensProfile = sqliteTable('project_lens_profile', {
  id: id(), projectId: integer('project_id').notNull().references(() => project.id, { onDelete: 'cascade' }),
  lensId: text('lens_id').references(() => lens.id, { onDelete: 'cascade' }), axis: text().notNull(),
  profileName: text('profile_name').notNull(), selectedVersion: integer('selected_version'),
}, (t) => [check('project_lens_profile_axis_check', sql`${t.axis} in ('framework','architecture')`),
  check('project_lens_profile_version_check', sql`${t.selectedVersion} is null or ${t.selectedVersion} > 0`),
  uniqueIndex('project_lens_profile_specific').on(t.projectId, t.lensId, t.axis).where(sql`${t.lensId} is not null`),
  uniqueIndex('project_lens_profile_global').on(t.projectId, t.axis).where(sql`${t.lensId} is null`)])
export const projectLensProfileRevision = sqliteTable('project_lens_profile_revision', {
  id: id(), selectionId: integer('selection_id').notNull().references(() => projectLensProfile.id, { onDelete: 'cascade' }),
  priorProfileName: text('prior_profile_name'), priorSelectedVersion: integer('prior_selected_version'),
  reason: text().notNull(), sessionId: text('session_id'), at: text().notNull(),
}, (t) => [check('project_lens_profile_revision_version_check', sql`${t.priorSelectedVersion} is null or ${t.priorSelectedVersion} > 0`),
  check('project_lens_profile_revision_reason_check', sql`length(trim(${t.reason})) > 0`)])

export const portPair = sqliteTable('port_pair', {
  id: id(), sourceProjectId: integer('source_project_id').notNull().references(() => project.id, { onDelete: 'restrict' }),
  targetProjectId: integer('target_project_id').notNull().references(() => project.id, { onDelete: 'restrict' }), createdAt: text('created_at').notNull(),
}, (t) => [check('port_pair_distinct_check', sql`${t.sourceProjectId} <> ${t.targetProjectId}`), unique('port_pair_source_target_unique').on(t.sourceProjectId, t.targetProjectId), index('port_pair_target').on(t.targetProjectId)])
export const portBaseline = sqliteTable('port_baseline', {
  pairId: integer('pair_id').primaryKey().references(() => portPair.id, { onDelete: 'cascade' }), sourceCommit: text('source_commit'), scannedAt: text('scanned_at'),
}, (t) => [check('port_baseline_pair_check', sql`(${t.sourceCommit} is null) = (${t.scannedAt} is null)`)])
export const portSkip = sqliteTable('port_skip', {
  id: id(), pairId: integer('pair_id').notNull().references(() => portPair.id, { onDelete: 'cascade' }), candidate: text().notNull(), reason: text().notNull(), skippedAt: text('skipped_at').notNull(),
}, (t) => [unique('port_skip_pair_candidate_unique').on(t.pairId, t.candidate), index('port_skip_pair').on(t.pairId)])
export const portRef = sqliteTable('port_ref', {
  taskKey: text('task_key').primaryKey(), targetProjectId: integer('target_project_id').notNull().references(() => project.id, { onDelete: 'restrict' }),
  note: text().notNull(), createdAt: text('created_at').notNull(), resolvedAt: text('resolved_at'),
}, (t) => [index('port_ref_target').on(t.targetProjectId)])
export const portRefSource = sqliteTable('port_ref_source', {
  id: id(), taskKey: text('task_key').notNull().references(() => portRef.taskKey, { onDelete: 'cascade' }), sourceProjectId: integer('source_project_id').notNull().references(() => project.id, { onDelete: 'restrict' }),
  commits: text().notNull(), paths: text().notNull(), note: text().notNull(),
}, (t) => [unique('port_ref_source_task_project_unique').on(t.taskKey, t.sourceProjectId), index('port_ref_source_task').on(t.taskKey)])
export const portDoctrine = sqliteTable('port_doctrine', {
  number: integer().primaryKey(), title: text().notNull(), body: text().notNull(), createdAt: text('created_at').notNull(), retiredAt: text('retired_at'),
}, (t) => [check('port_doctrine_number_check', sql`${t.number} > 0`)])

export const landingOverride = sqliteTable('landing_override', {
  id: id(), /** @deprecated Use projectId. */ project: text().notNull(), projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }), branch: text().notNull(), tip: text().notNull(), tree: text().notNull(), reason: text().notNull(), sessionId: text('session_id'), at: text().notNull(),
}, (t) => [check('landing_override_reason_check', sql`length(trim(${t.reason})) > 0`)])
export const landing = sqliteTable('landing', {
  id: id(), /** @deprecated Use projectId. */ project: text().notNull(), projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }), branch: text().notNull(), tip: text(),
  trunkBefore: text('trunk_before'), status: text().notNull(), error: text(),
  sessionId: text('session_id'), startedAt: text('started_at').notNull(), finishedAt: text('finished_at'),
  pathSet: text('path_set'), requestedAt: text('requested_at'), steps: text(),
  causingLandingId: integer('causing_landing_id'),
}, (t) => [
  check('landing_status_check', sql`${t.status} in ('queued','running','landed','refused','install_failed','rebase_required')`),
  check('landing_path_set_json_check', sql`${t.pathSet} is null or json_valid(${t.pathSet})`),
  check('landing_steps_json_check', sql`${t.steps} is null or json_valid(${t.steps})`),
  index('landing_project_started').on(t.project, t.startedAt),
])
export const testFlake = sqliteTable('test_flake', {
  id: id(),
  test: text().notNull(),
  file: text().notNull(),
  loadAtFailure: text('load_at_failure').notNull(),
  signal: text(),
  at: text().notNull(),
}, (t) => [
  check('test_flake_load_json_check', sql`json_valid(${t.loadAtFailure})`),
  index('test_flake_test_file_at').on(t.test, t.file, t.at),
])

export const landingReviewCarry = sqliteTable('landing_review_carry', {
  id: id(), /** @deprecated Use projectId. */ project: text().notNull(), projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }), branch: text().notNull(), tip: text().notNull(), tree: text().notNull(), reviewId: integer('review_id').notNull().references(() => review.id),
  reviewedCommit: text('reviewed_commit').notNull(), reviewedTree: text('reviewed_tree').notNull(), patchId: text('patch_id').notNull(), oldBase: text('old_base').notNull(),
  newBase: text('new_base').notNull(), sessionId: text('session_id'), at: text().notNull(),
})

export const contention = sqliteTable('contention', {
  id: id(), at: text().notNull(), sessionId: text('session_id'),
  resourceKind: text('resource_kind').notNull(), resourceKey: text('resource_key').notNull(),
  eventKind: text('event_kind').notNull(), durationMs: integer('duration_ms'), cause: text(),
  runId: integer('run_id'), landingId: integer('landing_id'),
}, (t) => [
  check('contention_resource_kind_check', sql`${t.resourceKind} in (${values(RESOURCE_KINDS)})`),
  check('contention_event_kind_check', sql`${t.eventKind} in (${values(EVENT_KINDS)})`),
  index('contention_kind_at').on(t.resourceKind, t.at),
  index('contention_session_at').on(t.sessionId, t.at),
  index('contention_landing').on(t.landingId),
])
