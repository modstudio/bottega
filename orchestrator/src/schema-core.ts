// concern: schema-core
import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { DOC_SCOPE_SUBJECT_KIND, DOC_SCOPES } from '../../shared/docs.ts'
import { RUN_MUTATION_ACTIONS } from './run-authority.ts'
import { DELIVERY, FIDELITY, QUALITY } from './score.ts'

export const values = (items: readonly string[]) =>
  sql.raw(items.map((item) => `'${item}'`).join(','))

export const subjectlessScopes = DOC_SCOPES.filter(
  (scope) => DOC_SCOPE_SUBJECT_KIND[scope] === null,
)

export const subjectScopes = DOC_SCOPES.filter((scope) => DOC_SCOPE_SUBJECT_KIND[scope] !== null)

export const id = () => integer('id').primaryKey({ autoIncrement: true })

export const agent = sqliteTable(
  'agent',
  {
    name: text().primaryKey(),
    harness: text().notNull(),
    backend: text(),
    model: text().notNull(),
    baseUrl: text('base_url'),
    transport: text().notNull().default('cli'),
    caps: text().notNull(),
    billing: text().notNull(),
    enabled: integer().notNull().default(1),
    disabledReason: text('disabled_reason'),
    probedAt: text('probed_at'),
    probeResult: text('probe_result'),
    jobs: text(),
    preferredJobs: text('preferred_jobs'),
    maxConcurrent: integer('max_concurrent'),
  },
  (t) => [
    check('agent_transport_check', sql`${t.transport} in ('cli','acp')`),
    check(
      'agent_billing_check',
      sql`${t.billing} in ('subscription','free','local','metered','unknown')`,
    ),
    check('agent_enabled_check', sql`${t.enabled} in (0,1)`),
    check('agent_caps_json_check', sql`json_valid(${t.caps})`),
    check(
      'agent_probe_result_json_check',
      sql`${t.probeResult} is null or json_valid(${t.probeResult})`,
    ),
    check('agent_jobs_json_check', sql`${t.jobs} is null or json_valid(${t.jobs})`),
    check(
      'agent_preferred_jobs_json_check',
      sql`${t.preferredJobs} is null or json_valid(${t.preferredJobs})`,
    ),
    check('agent_max_concurrent_check', sql`${t.maxConcurrent} is null or ${t.maxConcurrent} > 0`),
    check(
      'agent_disabled_reason_check',
      sql`(${t.enabled} = 1 and ${t.disabledReason} is null) or (${t.enabled} = 0 and length(trim(${t.disabledReason})) > 0)`,
    ),
  ],
)

export const run = sqliteTable(
  'run',
  {
    id: id(),
    recordId: text('record_id'),
    startedAt: text('started_at').notNull(),
    agent: text().notNull(),
    job: text().notNull(),
    /** @deprecated One-release mirror; use projectId. */
    repo: text(),
    projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }),
    cwd: text(),
    promptSha: text('prompt_sha').notNull(),
    specSha: text('spec_sha'),
    promptBytes: integer('prompt_bytes').notNull(),
    promptHead: text('prompt_head').notNull(),
    label: text(),
    lens: text(),
    latencyMs: integer('latency_ms'),
    exitCode: integer('exit_code'),
    outputBytes: integer('output_bytes'),
    outputPath: text('output_path'),
    promptPath: text('prompt_path'),
    vendorTokens: integer('vendor_tokens'),
    vendorCostUsd: real('vendor_cost_usd'),
    probe: integer().notNull().default(0),
    failureKind: text('failure_kind'),
    status: text().notNull().default('running'),
    error: text(),
    pid: integer(),
    sessionId: text('session_id'),
    retryOf: integer('retry_of'),
    launchCwd: text('launch_cwd'),
    launchSeed: text('launch_seed'),
    recipeSnapshot: text('recipe_snapshot'),
    launchKey: text('launch_key'),
    launchBase: text('launch_base'),
    noFailover: integer('no_failover').notNull().default(0),
    automaticFailover: integer('automatic_failover').notNull().default(0),
    routeReason: text('route_reason'),
    sandbox: text(),
    branch: text(),
    branchKept: text('branch_kept'),
    branchKeptTip: text('branch_kept_tip'),
    worktree: text(),
    worktreeSource: text('worktree_source'),
    vendorSession: text('vendor_session'),
    baseCommit: text('base_commit'),
    carryHappened: integer('carry_happened'),
    carryBaseCommit: text('carry_base_commit'),
    carryTrackedPaths: text('carry_tracked_paths'),
    carryUntrackedPaths: text('carry_untracked_paths'),
    parentRunId: integer('parent_run_id').references((): AnySQLiteColumn => run.id),
    turn: integer().notNull().default(1),
    filesChanged: integer('files_changed'),
    changedPaths: text('changed_paths'),
    linesAdded: integer('lines_added'),
    linesRemoved: integer('lines_removed'),
    testsRan: integer('tests_ran'),
    testsPassed: integer('tests_passed'),
    deviations: integer(),
    escalations: integer(),
    stack: text(),
    model: text(),
    runToken: text('run_token'),
    evidenceExcluded: text('evidence_excluded'),
    outsideWorktreeWrites: text('outside_worktree_writes'),
    inputTree: text('input_tree'),
    headCommit: text('head_commit'),
    reviewRef: text('review_ref'),
    agentPid: integer('agent_pid'),
    agentPgid: integer('agent_pgid'),
    agentStartTime: text('agent_start_time'),
    mcp: integer(),
    mcpServer: text('mcp_server'),
    mcpConnected: integer('mcp_connected'),
    mcpError: text('mcp_error'),
    mcpTrustGranted: integer('mcp_trust_granted'),
    mcpTrustPath: text('mcp_trust_path'),
    schemaPath: text('schema_path'),
    docsInjected: integer('docs_injected'),
    docRevisions: text('doc_revisions'),
    canonSha: text('canon_sha'),
    transport: text(),
    preConfinement: text('pre_confinement'),
    keepTree: integer('keep_tree').notNull().default(0),
    keepTreeUntil: text('keep_tree_until'),
    keepTreeReason: text('keep_tree_reason'),
    lastEventAt: text('last_event_at'),
    mintedBranch: text('minted_branch'),
    unreconciled: integer().notNull().default(0),
    mcpProbe: text('mcp_probe'),
    confinement: text(),
    reviewProvenance: text('review_provenance'),
    provenanceStatus: text('provenance_status'),
    workPreserved: integer('work_preserved').notNull().default(0),
    closeOutOutcome: text('close_out_outcome'),
    closeOutDetail: text('close_out_detail'),
    closeOutAttemptedAt: text('close_out_attempted_at'),
  },
  (t) => [
    check(
      'run_status_check',
      sql`${t.status} in ('running','ok','failed','stale','asking','stopped')`,
    ),
    check('run_unreconciled_check', sql`${t.unreconciled} in (0,1)`),
    check('run_sandbox_check', sql`${t.sandbox} is null or ${t.sandbox} in ('host','srt')`),
    check(
      'run_worktree_source_check',
      sql`${t.worktreeSource} is null or ${t.worktreeSource} in ('recipe','git','readonly_recipe')`,
    ),
    check('run_transport_check', sql`${t.transport} is null or ${t.transport} in ('cli','acp')`),
    check(
      'run_close_out_outcome_check',
      sql`${t.closeOutOutcome} is null or ${t.closeOutOutcome} in ('released','forgotten','held','live','absent','failed')`,
    ),
    index('run_job_agent').on(t.job, t.agent),
    index('run_parent_turn').on(t.parentRunId, t.turn),
    uniqueIndex('run_record_id_unique').on(t.recordId),
  ],
)

export const outbox = sqliteTable(
  'outbox',
  {
    id: id(),
    kind: text().notNull(),
    recordId: text('record_id').notNull(),
    payload: text().notNull(),
    createdAt: text('created_at').notNull(),
    attempts: integer().notNull().default(0),
    lastError: text('last_error'),
    syncedAt: text('synced_at'),
  },
  (table) => [index('outbox_synced_at').on(table.syncedAt)],
)

export const runCheckpoint = sqliteTable(
  'run_checkpoint',
  {
    id: id(),
    runId: integer('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    checkpointNo: integer('checkpoint_no').notNull(),
    commitSha: text('commit_sha').notNull(),
    taskPointer: text('task_pointer'),
    final: integer().notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => [unique('run_checkpoint_run_no_unique').on(t.runId, t.checkpointNo)],
)

export const score = sqliteTable(
  'score',
  {
    id: id(),
    runId: integer('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    delivery: text().notNull(),
    quality: text(),
    fidelity: text(),
    note: text(),
    scoredAt: text('scored_at').notNull(),
    scoredBy: text('scored_by').notNull().default('claude'),
  },
  (t) => [
    check('score_delivery_check', sql`${t.delivery} in (${values(DELIVERY)})`),
    check('score_quality_check', sql`${t.quality} in (${values(QUALITY)})`),
    check(
      'score_fidelity_check',
      sql`${t.fidelity} is null or ${t.fidelity} in (${values(FIDELITY)})`,
    ),
    check('score_delivery_quality_check', sql`(${t.delivery} = 'none') = (${t.quality} is null)`),
    index('score_run').on(t.runId),
    uniqueIndex('score_one_per_run').on(t.runId),
  ],
)

export const question = sqliteTable(
  'question',
  {
    id: id(),
    runId: integer('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    askedAt: text('asked_at').notNull(),
    question: text().notNull(),
    options: text(),
    recommendation: text(),
    why: text(),
    answer: text(),
    answeredAt: text('answered_at'),
    answeredBy: text('answered_by'),
    deliveryPendingAt: text('delivery_pending_at'),
  },
  (t) => [
    index('question_run').on(t.runId),
    index('question_open').on(t.answeredAt).where(sql`${t.answeredAt} is null`),
  ],
)

export const project = sqliteTable('project', {
  id: id(),
  name: text().notNull().unique(),
  path: text().notNull(),
  stack: text(),
  canon: integer().notNull().default(1),
  settings: text(),
  retiredAt: text('retired_at'),
})

export const resourceClaim = sqliteTable(
  'resource_claim',
  {
    id: id(),
    rootRunId: integer('root_run_id')
      .notNull()
      .references(() => run.id),
    runId: integer('run_id')
      .notNull()
      .references(() => run.id),
    projectId: integer('project_id').references(() => project.id),
    kind: text().notNull(),
    allocationKey: text('allocation_key').notNull(),
    identity: text(),
    /** The ownership label orch applies at creation, not a later observation. */
    label: text(),
    state: text().notNull(),
    claimedAt: text('claimed_at').notNull(),
    settledAt: text('settled_at'),
    settledDetail: text('settled_detail'),
  },
  (t) => [
    check(
      'resource_claim_kind_check',
      sql`${t.kind} in ('worktree','branch','retained_ref','sandbox_dir','trust_entry','port','database','index','string')`,
    ),
    check(
      'resource_claim_state_check',
      sql`${t.state} in ('claimed','released','retained','forgotten','absent')`,
    ),
    uniqueIndex('resource_claim_one_live_allocation')
      .on(t.kind, t.allocationKey)
      .where(sql`${t.state} = 'claimed'`),
  ],
)

export const blocker = sqliteTable(
  'blocker',
  {
    id: id(),
    runId: integer('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    at: text().notNull(),
    what: text().notNull(),
    why: text(),
    impact: text(),
    source: text().notNull(),
    kind: text(),
  },
  (t) => [
    check('blocker_source_check', sql`${t.source} in ('declared','detected')`),
    index('blocker_run').on(t.runId),
    index('blocker_kind').on(t.kind, t.at),
  ],
)

export const runMessage = sqliteTable(
  'run_message',
  {
    id: id(),
    direction: text().notNull(),
    rootRunId: integer('root_run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    runId: integer('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    senderSession: text('sender_session'),
    body: text().notNull(),
    createdAt: text('created_at').notNull(),
    readAt: text('read_at'),
    readBy: text('read_by'),
    delivery: text().notNull(),
  },
  (t) => [
    check('run_message_direction_check', sql`${t.direction} in ('to_worker','from_worker')`),
    check('run_message_body_check', sql`length(trim(${t.body})) > 0`),
    check('run_message_delivery_check', sql`${t.delivery} in ('architect_cli','worker_tool')`),
    index('run_message_root').on(t.rootRunId, t.id),
    index('run_message_unread')
      .on(t.rootRunId, t.direction, t.readAt)
      .where(sql`${t.readAt} is null`),
  ],
)

export const runMutationAudit = sqliteTable(
  'run_mutation_audit',
  {
    runId: integer('run_id')
      .notNull()
      .references(() => run.id),
    rootId: integer('root_id')
      .notNull()
      .references(() => run.id),
    action: text().notNull(),
    actorSession: text('actor_session'),
    at: text().notNull(),
    reason: text(),
  },
  (t) => [
    check('run_mutation_action_check', sql`${t.action} in (${values(RUN_MUTATION_ACTIONS)})`),
    check(
      'run_mutation_actor_check',
      sql`${t.actorSession} is null or length(${t.actorSession}) > 0`,
    ),
    index('run_mutation_audit_root').on(t.rootId),
  ],
)

export const metric = sqliteTable('metric', {
  day: text().primaryKey(),
  claudeTokens: integer('claude_tokens').notNull(),
  cacheRead: integer('cache_read').notNull(),
  messages: integer().notNull(),
  tasks: integer().notNull(),
  canonTokens: integer('canon_tokens').notNull().default(0),
  otherTokens: integer('other_tokens').notNull().default(0),
  commits: integer().notNull().default(0),
  files: integer().notNull().default(0),
  linesProduct: integer('lines_product').notNull().default(0),
  linesTest: integer('lines_test').notNull().default(0),
  linesDocs: integer('lines_docs').notNull().default(0),
  linesConfig: integer('lines_config').notNull().default(0),
  linesGenerated: integer('lines_generated').notNull().default(0),
  collectedAt: text('collected_at').notNull(),
})

export const spawn = sqliteTable(
  'spawn',
  {
    id: id(),
    at: text().notNull(),
    sessionId: text('session_id'),
    cwd: text(),
    event: text(),
    subagentType: text('subagent_type'),
    description: text(),
    promptBytes: integer('prompt_bytes'),
    decision: text().notNull(),
    why: text().notNull(),
  },
  (t) => [index('spawn_at').on(t.at)],
)

export const sessionSeen = sqliteTable('session_seen', {
  sessionId: text('session_id').primaryKey(),
  lastSeen: text('last_seen').notNull(),
})

export const schemaMeta = sqliteTable('schema_meta', {
  key: text().primaryKey(),
  value: text().notNull(),
})
