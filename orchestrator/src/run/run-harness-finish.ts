// concern: harness run finish
/** Collects an in-session harness reply through the ordinary terminal lifecycle. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  REPLY_FILE_NAME,
  realQuestions,
  resolveReplyDialect,
  TEXT_REPLY_SCHEMA,
  type WorkerReply,
} from '../contract/contract.ts'
import { db, sessionId } from '../database/db.ts'
import { repoRootOf } from '../git/git-environment.ts'
import { job } from '../jobs/jobs.ts'
import { runOwnedPaths } from '../run-owned-paths.ts'
import { EMPTY_VENDOR_USAGE } from '../transport/transport.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import * as acpWriter from './run-acp-writer.ts'
import { RUNS_DIR } from './run-artifacts.ts'
import { closeRun } from './run-close.ts'
import {
  callerRemovalAtRunEnd,
  type HarnessConfinementSnapshot,
  readHarnessConfinementSnapshot,
} from './run-confinement.ts'
import { HARNESS_EXECUTOR } from './run-executor.ts'
import { decideHarnessReply } from './run-harness-reply.ts'
import { withRunCloseOutLease } from './run-lease.ts'
import { replyContract } from './run-live.ts'
import { checksReviewedCommit } from './run-pack-prompt.ts'
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
  schema_path: string | null
  launch_key: string | null
  route_reason: string | null
  parent_run_record_id: string | null
}

function finishRefusal(row: HarnessRow | null, caller: string | null, id: string): string | null {
  if (!row)
    return `run ${id} does not exist; remedy: pass a run number or record id shown by ${PLATFORM_SLUG} run start`
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

type FinishFacts = {
  owned: HarnessRow & { cwd: string; prompt_path: string }
  requestedJob: ReturnType<typeof job>
  scratchDir: string
  outPath: string
  started: number
  worktree: Worktree | null
  decision: ReturnType<typeof decideHarnessReply>
  workerReply: WorkerReply | null
  acceptedQuestions: ReturnType<typeof realQuestions>
  error: string | null
  confinement: HarnessConfinementSnapshot
}

function harnessTerminalInput(facts: FinishFacts): Parameters<typeof finishRun>[0] {
  const { acceptedQuestions, decision, error, outPath, owned, requestedJob, scratchDir } = facts
  const refused = facts.workerReply?.status === 'refused'
  return {
    processless: true,
    timer: null,
    checkpointTimer: null,
    resourceObserver: null,
    proc: null,
    askLoopback: null,
    claim: { id: owned.record_id, number: owned.number },
    writesJob: Boolean(requestedJob.needs.writesRepo),
    worktree: facts.worktree,
    launchKey: owned.launch_key,
    failureKind: decision.failureKind,
    endpointKey: { secretName: null, source: 'agent', projectName: null },
    scratchDir,
    gitConfigEnvironment: undefined,
    writingAcp: Boolean(facts.worktree),
    checkpointContainment: acpWriter.prepareCheckpoint(
      facts.worktree,
      Boolean(facts.worktree),
      join(dirname(owned.prompt_path), 'runtime'),
    ),
    opts: { job: owned.job },
    watchedCheckouts: facts.confinement.watchedCheckouts,
    confinementFailures: facts.confinement.confinementFailures,
    frozenBefore: facts.confinement.watchedCheckouts,
    callerRemoval: callerRemovalAtRunEnd(db(), facts.confinement.callerCheckout, facts.started),
    removeIsolatedCwd: null,
    changes: null,
    provisionedMcpConfig: null,
    started: facts.started,
    retargetDiagnostic: null,
    error,
    contract: facts.workerReply as never,
    status: decision.status,
    contractObjects: decision.contractObjects,
    vendorTerminatedStream: null,
    acceptedQuestions,
    requestedJob,
    checkReviewedCommit: checksReviewedCommit(
      Boolean(requestedJob.findings),
      Boolean(requestedJob.needs.readsRepo),
    ),
    output: decision.output,
    confinementEvent: null,
    parsedReply: facts.workerReply as never,
    runProjectName: owned.repo,
    mcpConnection: null,
    mcpMode: null,
    declaredDeliverables: [],
    mcpSetupHeader: null,
    outPath,
    preConfinement: null,
    callerCwd: owned.cwd,
    promptPath: owned.prompt_path,
    exitCode: refused ? 0 : decision.status === 'failed' ? 1 : 0,
    vendorTokens: null,
    costUsd: null,
    vendorUsage: EMPTY_VENDOR_USAGE,
    effectiveModel: null,
    resolvedSession: null,
    name: 'harness',
    artifactsPersisted: true,
    mcpRuling: null,
    workerEvents: [],
  }
}

function closeHarnessRun(facts: FinishFacts, terminal: Awaited<ReturnType<typeof finishRun>>) {
  const { decision, outPath, owned, requestedJob } = facts
  return closeRun({
    failureKind: terminal.failureKind,
    endpointKey: { secretName: null, source: 'agent', projectName: null },
    name: 'harness',
    opts: { job: owned.job, noFailover: true },
    claim: { id: owned.record_id, number: owned.number },
    idleUnkillable: false,
    status: terminal.status,
    worktree: facts.worktree,
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
    started: facts.started,
    exitCode: decision.status === 'failed' ? 1 : 0,
    vendorTokens: null,
    costUsd: null,
    outPath,
    contract: facts.workerReply as never,
    error: terminal.error,
    run: async () => {
      throw new Error('automatic failover is refused for harness execution')
    },
  })
}

export async function finishHarnessRun(id: string) {
  const row = db().query('SELECT * FROM run WHERE record_id=?').get(id) as HarnessRow | null
  const refusal = finishRefusal(row, sessionId(), id)
  if (refusal) throw new Error(refusal)
  const owned = row!
  if (!owned.prompt_path || !owned.cwd)
    throw new Error(
      `run ${owned.number} is missing its prompt path or working directory; remedy: stop it with ${PLATFORM_SLUG} run stop ${owned.number}`,
    )
  const complete = owned as FinishFacts['owned']
  const requestedJob = job(complete.job)
  const dialect = resolveReplyDialect(requestedJob)
  const scratchDir = runOwnedPaths(
    complete.record_id,
    complete.parent_run_record_id ?? complete.record_id,
    RUNS_DIR,
  ).scratchDir
  const replyPath = join(scratchDir, REPLY_FILE_NAME)
  if (!existsSync(replyPath)) {
    throw new Error(
      `run ${complete.number} has no ${REPLY_FILE_NAME}; remedy: have the harness sub-agent write ${replyPath}, then run ${PLATFORM_SLUG} run finish ${complete.record_id}`,
    )
  }
  const replyText = readFileSync(replyPath, 'utf8')
  const schema = complete.schema_path
    ? JSON.parse(readFileSync(complete.schema_path, 'utf8'))
    : null
  const decision = decideHarnessReply(
    replyText,
    dialect,
    Boolean(requestedJob.needs.writesRepo),
    replyContract(
      complete.schema_path ?? undefined,
      !complete.schema_path && dialect.schema === TEXT_REPLY_SCHEMA,
    ),
    schema,
  )
  const workerReply = decision.reply as FinishFacts['workerReply']
  const error = decision.error
  const facts: FinishFacts = {
    owned: complete,
    requestedJob,
    scratchDir,
    outPath: join(dirname(complete.prompt_path), 'harness-output.txt'),
    started: Date.parse(complete.started_at),
    worktree: storedWorktree(complete),
    decision,
    workerReply,
    acceptedQuestions: workerReply ? realQuestions(workerReply as never) : [],
    error,
    confinement: readHarnessConfinementSnapshot(dirname(scratchDir)),
  }
  writeFileSync(facts.outPath, decision.output)
  return withRunCloseOutLease(
    complete.record_id,
    () => {},
    async () => closeHarnessRun(facts, await finishRun(harnessTerminalInput(facts))),
  )
}
