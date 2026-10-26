// concern: harness run finish
/** Collects an in-session harness reply through the ordinary terminal lifecycle. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { realQuestions, REPLY_FILE_NAME, resolveReplyDialect } from '../contract/contract.ts'
import { db, sessionId } from '../database/db.ts'
import { repoRootOf } from '../git/git-environment.ts'
import { job } from '../jobs/jobs.ts'
import { EMPTY_VENDOR_USAGE } from '../transport/transport.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import * as acpWriter from './run-acp-writer.ts'
import { closeRun } from './run-close.ts'
import { HARNESS_EXECUTOR } from './run-executor.ts'
import { runOwnedPaths } from '../run-owned-paths.ts'
import { RUNS_DIR } from './run-artifacts.ts'
import { decideHarnessReply } from './run-harness-reply.ts'
import { finishRun } from './run-terminal.ts'

type HarnessRow = {
  record_id: string
  number: number
  executor: string
  status: string
  session_id: string | null
  started_at: string
  job: string
  repo: string | null
  cwd: string | null
  worktree: string | null
  worktree_source: Worktree['source'] | null
  branch: string | null
  minted_branch: string | null
  base_commit: string | null
  prompt_path: string | null
  launch_key: string | null
  route_reason: string | null
  parent_run_record_id: string | null
}

function finishRefusal(row: HarnessRow | null, caller: string | null, id: string): string | null {
  if (!row) return `run ${id} does not exist; remedy: pass a run number or record id shown by ${PLATFORM_SLUG} run start`
  if (row.executor !== HARNESS_EXECUTOR)
    return `run ${row.number} uses executor ${row.executor}; remedy: let its coordinator finish it and use ${PLATFORM_SLUG} run result ${row.number}`
  if (row.status !== 'running')
    return `run ${row.number} is ${row.status}; remedy: use ${PLATFORM_SLUG} run result ${row.number}`
  if (!caller || row.session_id !== caller)
    return `run ${row.number} belongs to session ${row.session_id ?? '(none)'}; remedy: run ${PLATFORM_SLUG} run finish ${row.record_id} from its owning session`
  return null
}

function storedWorktree(row: HarnessRow): Worktree | null {
  if (!row.worktree) return null
  return {
    path: row.worktree,
    branch: row.branch ?? 'HEAD',
    base: row.base_commit ?? 'HEAD',
    repoRoot: repoRootOf(row.worktree) ?? row.worktree,
    source: row.worktree_source ?? undefined,
    mintedBranch: row.minted_branch,
  }
}

export async function finishHarnessRun(id: string) {
  const row = db().query('SELECT * FROM run WHERE record_id=?').get(id) as HarnessRow | null
  const refusal = finishRefusal(row, sessionId(), id)
  if (refusal) throw new Error(refusal)
  const owned = row!
  if (!owned.prompt_path || !owned.cwd) throw new Error(`run ${owned.number} is missing its prompt path or working directory; remedy: stop it with ${PLATFORM_SLUG} run stop ${owned.number}`)
  const requestedJob = job(owned.job)
  const dialect = resolveReplyDialect(requestedJob)
  const scratchDir = runOwnedPaths(
    owned.record_id,
    owned.parent_run_record_id ?? owned.record_id,
    RUNS_DIR,
  ).scratchDir
  const replyPath = join(scratchDir, REPLY_FILE_NAME)
  const replyText = existsSync(replyPath) ? readFileSync(replyPath, 'utf8') : null
  const decision = decideHarnessReply(replyText, dialect)
  const workerReply = decision.reply as ReturnType<typeof dialect.parse>['reply']
  const statusReply =
    workerReply && typeof workerReply === 'object' && 'status' in workerReply
      ? (workerReply as { status: string })
      : null
  const acceptedQuestions = statusReply ? realQuestions(workerReply as never) : []
  const refused = statusReply?.status === 'refused'
  const status = decision.status
  const error = replyText === null
    ? `${decision.error}; remedy: have the harness sub-agent write ${replyPath}, then run ${PLATFORM_SLUG} run finish ${owned.record_id}`
    : decision.error
  const failureKind = decision.failureKind
  const outPath = join(dirname(owned.prompt_path), 'harness-output.txt')
  writeFileSync(outPath, decision.output)
  const started = Date.parse(owned.started_at)
  const worktree = storedWorktree(owned)
  const checkpointContainment = acpWriter.prepareCheckpoint(worktree, Boolean(worktree), join(dirname(owned.prompt_path), 'runtime'))
  const terminal = await finishRun({
    processless: true,
    timer: null,
    checkpointTimer: null,
    resourceObserver: null,
    proc: null,
    askLoopback: null,
    claim: { id: owned.record_id, number: owned.number },
    writesJob: Boolean(requestedJob.needs.writesRepo),
    worktree,
    launchKey: owned.launch_key,
    failureKind,
    endpointKey: { secretName: null, source: 'agent', projectName: null },
    scratchDir,
    gitConfigEnvironment: undefined,
    writingAcp: Boolean(worktree),
    checkpointContainment,
    opts: { job: owned.job },
    watchedCheckouts: [],
    confinementFailures: [],
    frozenBefore: [],
    callerRemoval: { attribution: 'unattributed', removalSession: null, removalRun: null },
    removeIsolatedCwd: null,
    changes: null,
    provisionedMcpConfig: null,
    started,
    retargetDiagnostic: null,
    error,
    contract: workerReply as never,
    status,
    contractObjects: decision.contractObjects,
    vendorTerminatedStream: null,
    acceptedQuestions,
    requestedJob,
    checkReviewedCommit: Boolean(requestedJob.findings && requestedJob.needs.readsRepo),
    output: decision.output,
    confinementEvent: null,
    parsedReply: workerReply as never,
    runProjectName: owned.repo,
    mcpConnection: null,
    mcpMode: null,
    declaredDeliverables: [],
    mcpSetupHeader: null,
    outPath,
    preConfinement: null,
    callerCwd: owned.cwd,
    promptPath: owned.prompt_path,
    exitCode: refused ? 0 : status === 'failed' ? 1 : 0,
    vendorTokens: null,
    costUsd: null,
    vendorUsage: EMPTY_VENDOR_USAGE,
    effectiveModel: null,
    resolvedSession: null,
    name: 'harness',
    artifactsPersisted: true,
    mcpRuling: null,
    workerEvents: [],
  })
  return closeRun({
    failureKind: terminal.failureKind,
    endpointKey: { secretName: null, source: 'agent', projectName: null },
    name: 'harness',
    opts: { job: owned.job, noFailover: true },
    claim: { id: owned.record_id, number: owned.number },
    idleUnkillable: false,
    status: terminal.status,
    worktree,
    writesJob: Boolean(requestedJob.needs.writesRepo),
    changes: terminal.changes,
    artifactsPersisted: terminal.artifactsPersisted,
    idleTreePids: [],
    idleTreePgid: null,
    requestedJob,
    callerCwd: owned.cwd,
    repoJob: Boolean(requestedJob.needs.readsRepo),
    declaredDeliverables: [],
    timeoutMinutes: undefined,
    keepTree: undefined,
    reason: owned.route_reason ?? 'machine delegation mode',
    output: terminal.output,
    started,
    exitCode: status === 'failed' ? 1 : 0,
    vendorTokens: null,
    costUsd: null,
    outPath,
    contract: workerReply as never,
    error: terminal.error,
    run: async () => { throw new Error('automatic failover is refused for harness execution') },
  })
}
