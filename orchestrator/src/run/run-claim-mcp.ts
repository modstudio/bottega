// concern: claimed run MCP attachment
/** Executes the deferred MCP plan after the worker directory has its final address. */

import type { Agent } from '../agent/agents.ts'
import { workerHarnessName } from '../agent/worker-launch-env.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import {
  assertGrokTrustEligible,
  type DeferredCwdMcpStep,
  type McpConnection,
  type McpMode,
  mcpAttachRefusal,
  mcpConnectionFor,
} from '../mcp/mcp-preflight.ts'
import { wrongProjectReason } from '../mcp/mcp-probe.ts'
import { type Project, projectAt } from '../project/projects.ts'
import { ensureProjectMainStack } from '../resources/main-stack.ts'
import { recordTrustEntryClaims } from '../resources/resource-claims.ts'
import {
  beginResourceStep,
  completeResourceStep,
  markResourceStepStuck,
} from '../resources/resource-step-recorder.ts'
import {
  addedGrokTrustHeadings,
  grokTrustHeadings,
  grokTrustPathFromHeading,
  grokTrustStorePath,
} from '../sandbox/grok-trust.ts'
import type { prepareWorkerMcpConfig } from '../worktree/worktree-mcp.ts'
import { noRepoIsolatePath } from './run-artifacts.ts'
import { claimSandboxHomeStep } from './run-resource-step-recording.ts'
import {
  claimedGrokReaderConfig,
  prepareClaimedGrokMcpScope,
  prepareClaimedWorkerMcpConfig,
} from './run-worker-home.ts'

type PlanInput = {
  plan: DeferredCwdMcpStep[]
  callerCwd: string
  agent: Agent
  agentName: string
  runtimeDir: string
  runtimeDirExisted: boolean
  sandboxRootId: string
  runId: string
  runProjectId: string | null
  runsDir: string
  cwd: string
  inherited: boolean
  writesJob: boolean
  repoJob: boolean
  mcpMode: McpMode | null
  mcpConnection: McpConnection | null
  usingMcp: boolean
}

type DeferredMcpResult = {
  provisionedMcpConfig: ReturnType<typeof prepareWorkerMcpConfig> | null
  mcpSetupHeader: string | null
  mcpTrustGranted: boolean
  grokMcpEnvironment: Record<string, string>
  mcpConnection: McpConnection | null
  usingMcp: boolean
}

function requiredProject(project: Project | null, step: string): Project {
  if (!project) throw new Error(`deferred MCP ${step} ran before project preflight`)
  return project
}

function prepareScope(input: PlanInput, project: Project) {
  const prepare = () =>
    prepareClaimedGrokMcpScope({
      agent: input.agent,
      runDir: input.runtimeDir,
      runDirExisted: input.runtimeDirExisted,
      cwd: input.cwd,
      project,
      config: prepareClaimedWorkerMcpConfig({
        cwd: input.cwd,
        checkout: project.path,
        inherited: input.inherited,
        writesRepository: input.writesJob,
      }),
      ...claimedGrokReaderConfig(input.agent, input.writesJob, input.cwd, project, input.repoJob),
    })
  return claimSandboxHomeStep(db(), {
    rootRunId: input.sandboxRootId,
    runId: input.runId,
    projectId: input.runProjectId,
    repoJob: input.repoJob,
    writesJob: input.writesJob,
    harness: workerHarnessName(input.agent),
    sandbox: 'host',
    path: input.runtimeDir,
    claimedAt: nowIso(),
    effect: prepare,
  })
}

function recordTrust(
  input: PlanInput,
  environment: Record<string, string>,
  before: string[],
): void {
  const added = addedGrokTrustHeadings(before, grokTrustHeadings(environment))
  writeTrustOutcome(input, environment, added, null)
}

function writeTrustOutcome(
  input: PlanInput,
  environment: Record<string, string>,
  added: string[],
  pending: ReturnType<typeof beginResourceStep> | null,
): void {
  writeTransaction(() => {
    db()
      .query('UPDATE run SET mcp_trust_path=? WHERE record_id=?')
      .run(added.length ? JSON.stringify(added) : null, input.runId)
    if (pending) {
      completeResourceStep(db(), pending, {
        allocationKey: added[0],
        identity: grokTrustStorePath(environment),
      })
    } else {
      recordTrustEntryClaims(db(), {
        rootRunId: input.sandboxRootId,
        runId: input.runId,
        projectId: input.runProjectId,
        headings: added,
        storePath: grokTrustStorePath(environment),
        claimedAt: nowIso(),
      })
    }
  })
}

export function probeConnection(
  input: PlanInput,
  server: string,
  environment: Record<string, string>,
  connect: typeof mcpConnectionFor = mcpConnectionFor,
): { connection: McpConnection; trustGranted: boolean } {
  const trustGranted = input.agentName === 'grok'
  const recorded = db()
    .query('SELECT record_id, cwd, worktree, worktree_source FROM run WHERE record_id=?')
    .get(input.runId) as {
    record_id: string
    cwd: string | null
    worktree: string | null
    worktree_source: string | null
  } | null
  if (trustGranted) {
    assertGrokTrustEligible(
      input.cwd,
      recorded,
      noRepoIsolatePath(recorded?.record_id ?? input.runId, input.runsDir),
    )
  }
  const beforeTrust = trustGranted ? grokTrustHeadings(environment) : []
  const pendingTrust =
    trustGranted &&
    !input.writesJob &&
    !beforeTrust.some((heading) => grokTrustPathFromHeading(heading) === input.cwd)
      ? beginResourceStep(db(), {
          rootRunId: input.sandboxRootId,
          runId: input.runId,
          projectId: input.runProjectId,
          kind: 'trust_entry',
          allocationKey: input.cwd,
          identity: grokTrustStorePath(environment),
          label: input.sandboxRootId,
          claimedAt: nowIso(),
        })
      : null
  if (trustGranted)
    db().query('UPDATE run SET mcp_trust_granted=1 WHERE record_id=?').run(input.runId)
  let result: { connection: McpConnection; trustGranted: boolean } | undefined
  let effectError: unknown
  try {
    result = {
      connection: connect(
        input.agentName,
        input.cwd,
        server,
        trustGranted,
        input.repoJob,
        environment,
      ),
      trustGranted,
    }
  } catch (error) {
    effectError = error
  }
  if (trustGranted) {
    const added = addedGrokTrustHeadings(beforeTrust, grokTrustHeadings(environment))
    if (pendingTrust && added.length === 1) {
      writeTrustOutcome(input, environment, added, pendingTrust)
    } else if (pendingTrust && added.length > 1) {
      writeTransaction(() => {
        db()
          .query('UPDATE run SET mcp_trust_path=? WHERE record_id=?')
          .run(JSON.stringify(added), input.runId)
        markResourceStepStuck(
          db(),
          pendingTrust,
          `observed trust headings: ${JSON.stringify(added)}`,
          nowIso(),
        )
      })
      throw new Error(`Grok trust for ${input.cwd} created ${added.length} entries; expected one`)
    } else if (!pendingTrust) recordTrust(input, environment, beforeTrust)
  }
  if (effectError) throw effectError
  return result!
}

function normalizeConnection(
  input: PlanInput,
  server: string,
  connection: McpConnection,
  trustGranted: boolean,
): { connection: McpConnection; usingMcp: boolean } {
  if (
    trustGranted &&
    connection.connected === false &&
    /folder untrusted|repo-local server not started/i.test(connection.error ?? '')
  ) {
    throw new Error(
      `Grok remained untrusted after scoped trust for ${input.cwd}: ${connection.error}`,
    )
  }
  const mismatched = wrongProjectReason(server, connection.namesSeen ?? [])
  const checked = mismatched
    ? { ...connection, connected: false as const, error: mismatched }
    : connection
  const preferred = checked.connected === false && input.mcpMode === 'prefer'
  const normalized = preferred
    ? {
        ...checked,
        error: checked.error?.startsWith('wrong project:')
          ? checked.error
          : `mirror: ${checked.error ?? `server '${server}' could not be attached`}`,
      }
    : checked
  db()
    .query(`UPDATE run SET mcp_server=?, mcp_connected=?, mcp_error=? WHERE record_id=?`)
    .run(
      normalized.server,
      normalized.connected == null ? null : normalized.connected ? 1 : 0,
      normalized.error,
      input.runId,
    )
  const refusal = mcpAttachRefusal(normalized)
  if (refusal && input.mcpMode === 'require') throw new Error(refusal)
  return { connection: normalized, usingMcp: preferred ? false : input.usingMcp }
}

function provision(input: PlanInput, project: Project): DeferredMcpResult {
  const scope = prepareScope(input, project)
  const environment = scope.environment
  const probe = scope.error
    ? {
        connection: { server: scope.server, connected: false, error: scope.error },
        trustGranted: false,
      }
    : probeConnection(input, scope.server, environment)
  const normalized = normalizeConnection(input, scope.server, probe.connection, probe.trustGranted)
  return {
    provisionedMcpConfig: scope.config,
    mcpSetupHeader: scope.header,
    mcpTrustGranted: probe.trustGranted,
    grokMcpEnvironment: environment,
    mcpConnection: normalized.connection,
    usingMcp: normalized.usingMcp,
  }
}

function initialResult(input: PlanInput): DeferredMcpResult {
  let { mcpConnection, usingMcp } = input
  if (!input.plan.length && mcpConnection?.connected === false && input.mcpMode === 'prefer') {
    mcpConnection = {
      ...mcpConnection,
      error: `mirror: ${mcpConnection.error ?? `server '${mcpConnection.server}' could not be attached`}`,
    }
    usingMcp = false
    db().query('UPDATE run SET mcp_error=? WHERE record_id=?').run(mcpConnection.error, input.runId)
  }
  return {
    provisionedMcpConfig: null,
    mcpSetupHeader: null,
    mcpTrustGranted: false,
    grokMcpEnvironment: {},
    mcpConnection,
    usingMcp,
  }
}

export function executeClaimedMcpPlan(input: PlanInput): DeferredMcpResult {
  let project: Project | null = null
  let result = initialResult(input)
  for (const step of input.plan) {
    if (step === 'defer-cwd-preflight') {
      project = projectAt(input.callerCwd)
      if (!project)
        throw new Error(`no registered project identifies MCP configuration for ${input.callerCwd}`)
    } else if (step === 'ensure-main-stack') {
      ensureProjectMainStack(requiredProject(project, 'main-stack step'), 'mcp')
    } else {
      result = provision(input, requiredProject(project, 'provisioning'))
    }
  }
  return result
}
