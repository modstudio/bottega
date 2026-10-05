// concern: doctor
/** Knows machine and register diagnosis. Must not know transports, routing, run control, the CLI, or reviews by value. */
import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { doctorAgentStatus } from '../agent/agent-auth.ts'
import { AGENTS, agentRows } from '../agent/agent-registry.ts'
import { cliVersion, versionBelow } from '../agent/agents.ts'
import {
  ensureLocalHealth,
  fileContractProbeReason,
  lastWakeAttempt,
  modelHostModel,
  modelHostUrl,
  predatesFileContract,
  registeredContextTokens,
  registeredLocalAgent,
  tryWake,
  unavailableReason,
  wakeStatus,
} from '../agent/model-host.ts'
import { DATABASE_RESOLUTION, DB_PATH, databaseOpenMode, db } from '../database/db.ts'
import { runTotals } from '../evidence/evidence-query.ts'
import {
  classifiedDockerResources,
  dockerRemovalCommand,
  dockerRunResources,
} from '../resources/docker-resources.ts'
import {
  claimCounts,
  RECIPE_PORT_BAND,
  RESOURCE_CLAIM_MIGRATION,
} from '../resources/resource-claims.ts'
import { terminalDockerRetentionReasonForRun } from '../resources/resource-ownership.ts'
import { gwetAc1, quadraticWeightedKappa } from '../score/agreement.ts'
import { DELIVERY, FIDELITY, QUALITY } from '../score/score.ts'
import { keepTreeHold } from '../worktree/keep-tree-hold.ts'
import { worktreeDirty } from '../worktree/worktree-attribution.ts'
import { lifecycleReportLines } from '../worktree/worktree-lifecycle.ts'

type DoctorFlags = { has(name: string): boolean }
type DoctorPresentation = {
  log(...values: unknown[]): void
  exitCode(code: number): void
  candidates(job: string): { agent: string; cooling?: string | null }[]
  pick(job: string): { agent: string }
  jobs(): string[]
  acpRuntimeGaps(): string | null
  retrievalCheck(): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

export function canonEvalDoctorDecision(input: {
  pass: boolean
  recordedSha: string
  currentSha: string | null
  currentCanonError: string | null
}): { result: 'pass (current canon)' | 'pass' | 'FAIL'; unavailableReason: string | null } {
  const result = input.pass
    ? input.currentSha !== null && input.recordedSha === input.currentSha
      ? 'pass (current canon)'
      : 'pass'
    : 'FAIL'
  return { result, unavailableReason: input.currentCanonError }
}

/** ACP is optional because built-in Codex writing jobs use the CLI transport. */
export function doctorAcpStatus(gap: string | null): string {
  return gap ? `informational — ${gap}` : 'ready'
}

function localRegistrationDiagnosis(baseUrl: string, configuredModel: string | undefined) {
  const registration = registeredLocalAgent(agentRows(), baseUrl)
  const contextTokens = registration ? registeredContextTokens(registration) : null
  const lines = [
    `\nlocal endpoint  ${baseUrl || '(ORCH_MODEL_HOST_URL unset)'}`,
    `local model     ${registration?.model || '(not registered)'}`,
  ]
  if (baseUrl && !registration) {
    lines.push(
      configuredModel
        ? `register        orch agent add qwen36-goose --harness goose --backend vllm --model ${configuredModel} --base-url ${baseUrl} --context-tokens <tokens>`
        : 'register        ORCH_MODEL_HOST_MODEL is required before registering qwen36-goose',
    )
  }
  if (registration && contextTokens === null) {
    lines.push(
      `context         not declared — run orch agent set ${registration.name} --context-tokens <tokens>`,
    )
  }
  return { registration, contextTokens, lines }
}

function localContextDiagnosis(
  servedContext: number | undefined,
  registration: ReturnType<typeof localRegistrationDiagnosis>['registration'],
  declaredContext: number | null,
): string | null {
  if (!servedContext || !registration || declaredContext === null) return null
  if (servedContext === declaredContext) {
    return `context         ${(servedContext / 1024).toFixed(0)}K served (matches what routing assumes)`
  }
  return (
    `context         ${(servedContext / 1024).toFixed(0)}K served` +
    `  MISMATCH — registry declares ${(declaredContext / 1024).toFixed(0)}K.` +
    ` Run orch agent set ${registration.name} --context-tokens ${servedContext} or re-serve.`
  )
}

function reportRetrievalCheck(
  result: { stdout: string; stderr: string; exitCode: number },
  presentation: Pick<DoctorPresentation, 'log' | 'exitCode'>,
): void {
  presentation.log('retrieval endpoints')
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) presentation.log(`  ${line}`)
  if (result.stderr.trim()) presentation.log(`  ${result.stderr.trim()}`)
  if (result.exitCode !== 0) presentation.exitCode(1)
}

export async function doctorCommand(
  flags: DoctorFlags,
  presentation: DoctorPresentation,
  agentStatus: typeof doctorAgentStatus = doctorAgentStatus,
): Promise<void> {
  const { has } = flags
  const { log, exitCode, candidates, pick, jobs, acpRuntimeGaps, retrievalCheck } = presentation
  // Probed BEFORE the agent list is printed, not after it. Doctor used to
  // report `qwen36-goose ready` and `reachable NO` four lines apart and mean
  // both: the roster asked whether it was configured and the probe asked
  // whether it answered. Now the roster is told the answer first, so the
  // status column and the routing table below it cannot contradict
  // each other.
  const r = await ensureLocalHealth()
  reportRetrievalCheck(await retrievalCheck(), presentation)
  const { CanonBudgetError, compilePack, findingsForPack } = await import('../canon/canon.ts')
  const { listDocs } = await import('../doc/docs.ts')
  const { DEFAULT_PACK_BYTES, MAX_INJECT_DOC_BYTES } = await import('../canon/pack-budget.ts')
  let doctorPack: ReturnType<typeof compilePack>
  try {
    doctorPack = compilePack({ job: 'understand', cwd: process.cwd() })
  } catch (error) {
    if (!(error instanceof CanonBudgetError)) throw error
    doctorPack = error.pack
  }
  const doctorFindings = findingsForPack(doctorPack).reduce((n, row) => n + row.findings.length, 0)
  const packHeadroom = doctorPack.budgetBytes - doctorPack.bytes
  const { CANON_EVALS, currentCanonEvalSha, latestCanonEvals } = await import('../canon/evals.ts')
  const latestEvals = latestCanonEvals()
  const { isReadonlySandboxCandidate } = await import('../sandbox/sandbox.ts')
  const { sandboxRuntimeAvailability } = await import('../sandbox/sandbox-runtime.ts')
  log(
    `canon          ${doctorFindings} finding(s) in ${doctorPack.bytes}/${doctorPack.budgetBytes} bytes (${packHeadroom} bytes headroom; ceiling ${DEFAULT_PACK_BYTES})`,
  )
  const oversized = listDocs()
    .filter(
      (doc) => doc.delivery === 'inject' && Buffer.byteLength(doc.body) > MAX_INJECT_DOC_BYTES,
    )
    .sort((a, b) => Buffer.byteLength(b.body) - Buffer.byteLength(a.body))
  if (oversized.length) {
    log('canon oversize')
    for (const doc of oversized) {
      log(`  ${Buffer.byteLength(doc.body)}  ${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`)
    }
  }
  log('canon evals')
  for (const ev of CANON_EVALS) {
    const rows = latestEvals.filter((row) => row.slug === ev.slug)
    if (!rows.length) {
      log(`  ${ev.slug.padEnd(30)} skipped  —  never run`)
      continue
    }
    let currentSha: string | null = null
    let currentCanonError: string | null = null
    try {
      currentSha = currentCanonEvalSha(ev, { project: PLATFORM_SLUG })
    } catch (error) {
      currentCanonError = error instanceof Error ? error.message : String(error)
    }
    for (const row of rows) {
      const { result } = canonEvalDoctorDecision({
        pass: row.pass,
        recordedSha: row.canon_sha,
        currentSha,
        currentCanonError,
      })
      log(`  ${ev.slug.padEnd(30)} ${result.padEnd(20)} ${row.agent}  ${row.at}`)
    }
    if (currentCanonError !== null) {
      log(`  ${ev.slug.padEnd(30)} current canon unavailable — ${currentCanonError}`)
    }
  }
  const failingEvalSlugs = [
    ...new Set(latestEvals.filter((row) => !row.pass).map((row) => row.slug)),
  ]
  if (failingEvalSlugs.length) {
    log(`FAILING CANON EVALS: ${failingEvalSlugs.join(', ')}`)
  }
  db()
  log(`database       ${DB_PATH}`)
  log(`open mode      ${databaseOpenMode()}`)
  const { expectedSchemaHash, canonicalSchemaHash, schemaVersionLabel } = await import(
    '../database/migrations.ts'
  )
  log(`schema hash    ${canonicalSchemaHash(db()) === expectedSchemaHash() ? 'match' : 'DRIFT'}`)
  log(`schema version ${schemaVersionLabel(db())}`)
  log(`resolved by    ${DATABASE_RESOLUTION.method}`)
  if (DATABASE_RESOLUTION.registeredPath && DATABASE_RESOLUTION.registeredPath !== DB_PATH) {
    log(`registered     ${DATABASE_RESOLUTION.registeredPath}  (resolved path won)`)
  }
  const { harnessHealth } = await import('./health.ts')
  const costlyFailures = harnessHealth()
    .classes.filter((row) => row.count > 0)
    .sort((a, b) => b.totalTimeMs - a.totalTimeMs || a.kind.localeCompare(b.kind))
    .slice(0, 2)
  log('harness health top live classes by total time (14 days; never routing evidence)')
  for (const row of costlyFailures) {
    log(`  ${row.kind.padEnd(24)} ${(row.totalTimeMs / 60_000).toFixed(1)}m  last ${row.lastSeen}`)
  }
  const latestCalibration = db().query('SELECT MAX(at) AS at FROM calibration').get() as {
    at: string | null
  }
  if (latestCalibration.at) {
    const calibrationRows = db()
      .query(
        `SELECT s.delivery original_delivery, c.delivery fresh_delivery,
              s.quality original_quality, c.quality fresh_quality,
              s.fidelity original_fidelity, c.fidelity fresh_fidelity
         FROM calibration c JOIN score s ON s.run_id = c.run_id
        WHERE c.at = ?`,
      )
      .all(latestCalibration.at) as Record<string, string | null>[]
    log(`scorer calibration  ${latestCalibration.at}`)
    const calibrationAxes = [
      { name: 'delivery', levels: DELIVERY as readonly string[] },
      { name: 'quality', levels: QUALITY as readonly string[] },
      { name: 'fidelity', levels: FIDELITY as readonly string[] },
    ]
    for (const axis of calibrationAxes) {
      const pairs = calibrationRows
        .map((row) => [row[`original_${axis.name}`], row[`fresh_${axis.name}`]] as const)
        .filter((pair) => pair[0] !== null && pair[1] !== null) as [string, string][]
      if (!pairs.length) continue
      const kappa = quadraticWeightedKappa(pairs, axis.levels)
      const ac1 = gwetAc1(pairs, axis.levels)
      log(
        `  ${axis.name.padEnd(8)} n=${pairs.length} ` +
          `kappa=${kappa === null ? 'n/a' : kappa.toFixed(3)} ` +
          `ac1=${ac1 === null ? 'n/a' : ac1.toFixed(3)}`,
      )
    }
  } else {
    log('scorer calibration  never')
  }
  const scoresSinceCalibration = (
    db()
      .query(
        `SELECT COUNT(*) n FROM score
      WHERE ? IS NULL OR datetime(scored_at) > datetime(?)`,
      )
      .get(latestCalibration.at, latestCalibration.at) as { n: number }
  ).n
  const calibrationStale =
    !latestCalibration.at ||
    Date.now() - new Date(latestCalibration.at).getTime() >= 30 * 86_400_000 ||
    scoresSinceCalibration >= 100
  if (calibrationStale) {
    log(
      `recalibrate: ${scoresSinceCalibration} scores since last blind check; ` +
        'run orch recalibrate --n 12',
    )
  }
  log('agents')
  for (const a of Object.values(AGENTS)) {
    const cool = candidates('summarize').find((c) => c.agent === a.name)?.cooling
    const why = unavailableReason(a.name)
    const version = why === 'not installed' ? null : cliVersion(a.bin)
    const old = version?.parsed && versionBelow(version.parsed, a.minimumCliVersion)
    const auth = agentStatus(a.name, why, a.bin)
    log(
      `  ${a.name.padEnd(12)} ${auth.status.padEnd(7)} ${a.billing.padEnd(13)}` +
        (auth.detail ? `  ${auth.detail}` : '') +
        (version ? `  version ${version.display}` : '  version unavailable') +
        (cool ? `  COOLING: ${cool}` : ''),
    )
    if (old) {
      log(`  WARNING: ${a.name} ${version.parsed} is below minimum ${a.minimumCliVersion}`)
    }
    if (predatesFileContract(a)) {
      log(`  ${fileContractProbeReason(a.name)}`)
    }
  }
  for (const row of agentRows()) {
    if (row.operated_by !== 'self' || !row.enabled) continue
    const probedAt = row.probed_at ? Date.parse(row.probed_at) : NaN
    const ageDays = Number.isFinite(probedAt) ? (Date.now() - probedAt) / 86_400_000 : null
    const probe = row.probe_result ? (JSON.parse(row.probe_result) as { ok?: boolean }) : null
    const stale = ageDays !== null && ageDays > 7
    const failed = probe?.ok === false
    const age = ageDays === null ? 'never' : `${ageDays.toFixed(1)}d`
    if (stale || failed) {
      log(`local probe     ${row.name} FAIL ${age}${failed ? ' probe failed' : ' exceeds 7 days'}`)
      exitCode(1)
    } else {
      log(`local probe     ${row.name} ${age}`)
    }
  }
  const srtAgents = Object.values(AGENTS)
    .filter((agent) =>
      isReadonlySandboxCandidate({
        agent: agent.name,
        readsRepo: agent.caps.readsRepo,
        writesRepo: false,
      }),
    )
    .map((agent) => agent.name)
  const sandboxRuntime = sandboxRuntimeAvailability()
  log(
    `sandbox        runtime ${sandboxRuntime.available ? 'available' : 'NOT AVAILABLE'} at ${sandboxRuntime.location}`,
  )
  log(`sandbox agents ${srtAgents.join(', ') || '(none)'} (read-only repository jobs)`)
  const acpGap = acpRuntimeGaps()
  log(`acp            ${doctorAcpStatus(acpGap)}`)
  const configuredUrl = modelHostUrl()
  const local = localRegistrationDiagnosis(configuredUrl, modelHostModel())
  for (const line of local.lines) log(line)
  log(`reachable       ${r.ok ? 'yes' : 'NO'} — ${r.detail}`)
  if (!r.ok && configuredUrl) {
    // Reporting commands do not have side effects, so doctor only sends a
    // packet when asked in as many words. `orch do` wakes on its own; a
    // status check that silently powered on a shared machine would be a
    // surprise, and the surprise would land on a colleague.
    if (has('wake')) {
      const w = tryWake()
      log(`\nwake            ${w.sent ? 'SENT' : 'not sent'} — ${w.detail}`)
    } else {
      const d = wakeStatus()
      const last = lastWakeAttempt()
      log(
        `\nwake            ${d.send ? 'available — orch doctor --wake' : d.detail}` +
          (last ? `  (last attempt ${last.toISOString()})` : ''),
      )
    }
  }
  if (!r.ok && configuredUrl) {
    // The endpoint is a tunnel to another machine, so "not reachable" has a
    // short list of causes and they are checked in a fixed order. Printed
    // here because this is where somebody looks when the local model goes
    // quiet, and the alternative is rediscovering the list each time.
    log(
      '\nthe local model is out of routing until this clears. In order:\n' +
        '  1. is the box up?      ping <host-alias>\n' +
        '  2. is the tunnel up?   launchctl list com.user.local-model-tunnel\n' +
        '     and its log:        ~/Library/Logs/local-model-tunnel/launchd.err.log\n' +
        "  3. is the server up?   ssh <host-alias> 'docker ps'\n" +
        'Routing has already excluded it, so nothing is being sent at it meanwhile.',
    )
  }
  // Where someone looks when an agent has gone quiet, so it is where the way
  // out belongs. A cooldown clears on the agent's next success, and routing
  // will not send it one while anything else can take the work — so without
  // this the only options are waiting out the hour or reading route.ts.
  if (candidates('summarize').some((c) => c.cooling)) {
    log(
      '\nan agent is cooling. If you have fixed the cause — topped up a quota,\n' +
        'logged back in — prove it and the cooldown clears immediately:\n' +
        '  orch probe <name>\n' +
        'A probe never counts as routing evidence, but it does count as being alive.',
    )
  }
  // The served window decides which jobs the local model is eligible for, so
  // a silent drift between what is declared and what is running would route
  // work at an agent that cannot hold it — which is how it came to be handed
  // four review-lenses and an `understand` it could never have finished.
  const contextDiagnosis = localContextDiagnosis(
    r.contextTokens,
    local.registration,
    local.contextTokens,
  )
  if (contextDiagnosis) log(contextDiagnosis)
  const counts = runTotals()
  // runTotals().unscored, not runs - scored: that subtraction counts probes,
  // in-flight runs, failures and abandoned rows as debt, and reported 28
  // owing where `orch pending` — the command that actually tells you what
  // to do about it — reported none.
  log(
    `\nruns ${counts.runs}, scored ${counts.scored}, voided ${counts.voided}, unscored ${counts.unscored}`,
  )
  const claims = claimCounts(db())
  const claimsByKind = claims.byKind.map(({ kind, count }) => `${kind} ${count}`).join(', ')
  log(
    `claims: ${claims.claimed} claimed (${claimsByKind}), ` +
      `${claims.terminal} unsettled on terminal conversations ` +
      `(since ${RESOURCE_CLAIM_MIGRATION}; historical runs are not backfilled)`,
  )
  const claimedPorts = claims.byKind.find(({ kind }) => kind === 'port')?.count ?? 0
  log(`ports: ${claimedPorts} of ${RECIPE_PORT_BAND.end - RECIPE_PORT_BAND.start} claimed`)
  const claimedIndexes = claims.byKind.find(({ kind }) => kind === 'index')?.count ?? 0
  const claimedStrings = claims.byKind.find(({ kind }) => kind === 'string')?.count ?? 0
  log(`allocations: ${claimedIndexes} index, ${claimedStrings} string claims live`)
  const heldCandidates = db()
    .query(
      `SELECT worktree, MAX(keep_tree) keep_tree, MAX(keep_tree_until) keep_tree_until,
              MIN(started_at) started_at FROM run
      WHERE worktree IS NOT NULL AND status IN ('ok','failed','stale','stopped')
      GROUP BY worktree`,
    )
    .all() as {
    worktree: string
    keep_tree: number
    keep_tree_until: string | null
    started_at: string
  }[]
  let explicitHolds = 0
  let dirtyHolds = 0
  for (const held of heldCandidates) {
    const hold = keepTreeHold({
      keepTree: held.keep_tree,
      keepTreeUntil: held.keep_tree_until,
      startedAt: held.started_at,
      now: new Date().toISOString(),
    })
    if (hold.held) explicitHolds++
    else if (existsSync(held.worktree) && worktreeDirty(held.worktree).dirty) dirtyHolds++
  }
  log(
    `held worktrees ${explicitHolds + dirtyHolds} (${dirtyHolds} dirty, ${explicitHolds} --keep-tree)`,
  )
  const {
    absentTreeTeardownPlan,
    projectByName,
    projects: registeredProjects,
    isProjectRepository,
    resolvedWorktreeTool,
    undeclaredCommitHooks,
    registerBranchCheck,
  } = await import('../project/projects.ts')
  const repositoryProjects = registeredProjects().filter(isProjectRepository)
  lifecycleReportLines(
    repositoryProjects.map((project) => ({
      name: project.name,
      path: project.path,
      worktree: project.settings.worktree,
    })),
    existsSync,
  ).forEach((line) => {
    log(line)
  })
  const hookFlags = repositoryProjects.map(undeclaredCommitHooks).filter(Boolean)
  if (hookFlags.length) {
    log('\ncommit hooks skipped in worker trees; landing gate must declare the checks:')
    for (const line of hookFlags) log(`  ${line}`)
  }
  const registerQuestions = repositoryProjects.flatMap((project) =>
    registerBranchCheck(project).problems.map((problem) => `${project.name}: ${problem}`),
  )
  if (registerQuestions.length) {
    log('\nregister questions (not run failures):')
    for (const question of registerQuestions) log(`  ${question}`)
  }
  const docker = dockerRunResources(repositoryProjects.map(({ path }) => path))
  const dockerResources = docker.ascertainable ? docker.resources : []
  const dockerOwnerIds = new Set(dockerResources.map(({ runId }) => runId))
  const owners = (
    db()
      .query(
        `SELECT r.id,COALESCE(root.repo,r.repo) repo,r.worktree,r.status,
                COALESCE(root.worktree_source,r.worktree_source) worktree_source,
                COALESCE(root.recipe_snapshot,r.recipe_snapshot) recipe_snapshot,
                COALESCE(root.resource_teardown,r.resource_teardown) resource_teardown
         FROM run r LEFT JOIN run root ON root.id=r.parent_run_id`,
      )
      .all() as {
      id: number
      repo: string | null
      worktree: string | null
      status: string
      worktree_source: 'recipe' | 'git' | 'clone' | 'readonly_recipe' | null
      recipe_snapshot: string | null
      resource_teardown: 'pending' | 'done' | null
    }[]
  ).map((owner) => ({
    ...owner,
    absentTreeTeardown:
      Boolean(owner.worktree && !existsSync(owner.worktree)) &&
      absentTreeTeardownPlan({
        recipeSnapshot: owner.recipe_snapshot,
        worktreeSource: owner.worktree_source,
        resourceTeardown: owner.resource_teardown,
        registeredRemoveCommand: Boolean(
          resolvedWorktreeTool(owner.repo ? projectByName(owner.repo) : null)?.remove,
        ),
      }),
    retentionReason: dockerOwnerIds.has(owner.id)
      ? terminalDockerRetentionReasonForRun(db(), owner.id)
      : null,
  }))
  const classified = classifiedDockerResources(dockerResources, owners)
  const orphans = classified.filter(({ condition }) => condition === 'leaked')
  const retained = classified.filter(({ condition }) => condition === 'retained-worktree-resources')
  if (!docker.ascertainable) {
    log(`\ndocker inventory unascertainable`)
    log(`  ${docker.reason}`)
  } else {
    log(`\ndocker orphans  ${orphans.length}`)
    for (const { resource, project } of orphans) {
      log(`  ${resource.kind} ${resource.name} — project ${project}, run ${resource.runId}`)
      log(`    ${dockerRemovalCommand(resource)}`)
    }
    log(`docker retained worktree resources  ${retained.length}`)
    for (const { resource, project, reason } of retained) {
      log(
        `  ${resource.kind} ${resource.name} — project ${project}, run ${resource.runId}; informational, ${reason ? `removal could not be ascertained: ${reason}; ` : ''}no removal suggested`,
      )
    }
  }
  for (const j of jobs()) {
    try {
      const p = pick(j)
      log(`  ${j.padEnd(15)} -> ${p.agent}`)
    } catch (e) {
      log(`  ${j.padEnd(15)} -> none (${(e as Error).message})`)
    }
  }
  return
}
