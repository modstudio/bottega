// concern: doctor
/** Knows machine and register diagnosis. Must not know transports, routing, run control, the CLI, or reviews by value. */
import { existsSync } from 'node:fs'
import { doctorAgentStatus } from './agent-auth.ts'
import { AGENTS, agentRows } from './agent-registry.ts'
import { cliVersion, versionBelow } from './agents.ts'
import { gwetAc1, quadraticWeightedKappa } from './agreement.ts'
import { DATABASE_RESOLUTION, DB_PATH, databaseOpenMode, db } from './db.ts'
import {
  classifiedDockerResources,
  dockerRemovalCommand,
  dockerRunResources,
} from './docker-resources.ts'
import { runTotals } from './evidence-query.ts'
import {
  ensureLocalHealth,
  fileContractProbeReason,
  LOCAL_BASE_URL,
  LOCAL_CONTEXT_TOKENS,
  LOCAL_MODEL,
  lastWakeAttempt,
  predatesFileContract,
  tryWake,
  unavailableReason,
  wakeStatus,
} from './local-host.ts'
import { claimCounts, RESOURCE_CLAIM_MIGRATION } from './resource-claims.ts'
import { terminalDockerRetentionReasonForRun } from './resource-ownership.ts'
import { DELIVERY, FIDELITY, QUALITY } from './score.ts'
import { worktreeDirty } from './worktree-attribution.ts'

type DoctorFlags = { has(name: string): boolean }
type DoctorPresentation = {
  log(...values: unknown[]): void
  exitCode(code: number): void
  candidates(job: string): { agent: string; cooling?: string | null }[]
  pick(job: string): { agent: string }
  jobs(): string[]
  acpRuntimeGaps(): string | null
}

export async function doctorCommand(
  flags: DoctorFlags,
  presentation: DoctorPresentation,
  agentStatus: typeof doctorAgentStatus = doctorAgentStatus,
): Promise<void> {
  const { has } = flags
  const { log, exitCode, candidates, pick, jobs, acpRuntimeGaps } = presentation
  // Probed BEFORE the agent list is printed, not after it. Doctor used to
  // report `qwen-local ready` and `reachable NO` four lines apart and mean
  // both: the roster asked whether it was configured and the probe asked
  // whether it answered. Now the roster is told the answer first, so the
  // status column and the routing table below it cannot contradict
  // each other.
  const r = await ensureLocalHealth()
  const { CanonBudgetError, compilePack, findingsForPack } = await import('./canon.ts')
  const { listDocs } = await import('./docs.ts')
  const { DEFAULT_PACK_BYTES, MAX_INJECT_DOC_BYTES } = await import('./pack-budget.ts')
  let doctorPack: ReturnType<typeof compilePack>
  try {
    doctorPack = compilePack({ job: 'understand', cwd: process.cwd() })
  } catch (error) {
    if (!(error instanceof CanonBudgetError)) throw error
    doctorPack = error.pack
  }
  const doctorFindings = findingsForPack(doctorPack).reduce((n, row) => n + row.findings.length, 0)
  const packHeadroom = doctorPack.budgetBytes - doctorPack.bytes
  const { CANON_EVALS, currentCanonEvalSha, latestCanonEvals } = await import('./evals.ts')
  const latestEvals = latestCanonEvals()
  const { isReadonlySandboxCandidate, srtInstalled, SRT_LIBRARY } = await import('./sandbox.ts')
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
    const currentSha = currentCanonEvalSha(ev)
    for (const row of rows) {
      const result = row.pass
        ? row.canon_sha === currentSha
          ? 'pass (current canon)'
          : 'pass'
        : 'FAIL'
      log(`  ${ev.slug.padEnd(30)} ${result.padEnd(20)} ${row.agent}  ${row.at}`)
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
    './migrations.ts'
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
    if (row.billing !== 'local' || !row.enabled) continue
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
  log(
    `sandbox        srt library ${srtInstalled() ? 'installed' : 'NOT INSTALLED'} at ${SRT_LIBRARY}`,
  )
  log(`sandbox agents ${srtAgents.join(', ') || '(none)'} (read-only repository jobs)`)
  const acpGap = acpRuntimeGaps()
  log(`acp            ${acpGap ?? 'ready'}`)
  log(`\nlocal endpoint  ${LOCAL_BASE_URL || '(ORCH_LOCAL_BASE_URL unset)'}`)
  log(`local model     ${LOCAL_MODEL}`)
  log(`reachable       ${r.ok ? 'yes' : 'NO'} — ${r.detail}`)
  const localRegistered =
    LOCAL_BASE_URL &&
    agentRows().some(
      (row) => Boolean(row.enabled) && row.transport === 'acp' && row.base_url === LOCAL_BASE_URL,
    )
  if (LOCAL_BASE_URL && !localRegistered) {
    const configuredModel = process.env.ORCH_LOCAL_MODEL
    log(
      configuredModel
        ? `register        orch agent add local-acp --harness goose --backend vllm --model ${configuredModel} --base-url ${LOCAL_BASE_URL}`
        : 'register        ORCH_LOCAL_MODEL is required before registering local-acp',
    )
  }
  if (!r.ok && LOCAL_BASE_URL) {
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
  if (!r.ok && LOCAL_BASE_URL) {
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
        '  orch do file-question --agent <name> --probe "Reply with exactly: OK"\n' +
        'A probe never counts as routing evidence, but it does count as being alive.',
    )
  }
  // The served window decides which jobs the local model is eligible for, so
  // a silent drift between what is declared and what is running would route
  // work at an agent that cannot hold it — which is how it came to be handed
  // four review-lenses and an `understand` it could never have finished.
  if (r.contextTokens) {
    const agree = r.contextTokens === LOCAL_CONTEXT_TOKENS
    log(
      `context         ${(r.contextTokens / 1024).toFixed(0)}K served` +
        (agree
          ? ' (matches what routing assumes)'
          : `  MISMATCH — routing assumes ${(LOCAL_CONTEXT_TOKENS / 1024).toFixed(0)}K.` +
            ` Set ORCH_LOCAL_CONTEXT=${r.contextTokens} or re-serve.`),
    )
  }
  const counts = runTotals()
  // runTotals().unscored, not runs - scored: that subtraction counts probes,
  // in-flight runs, failures and abandoned rows as debt, and reported 28
  // owing where `orch pending` — the command that actually tells you what
  // to do about it — reported none.
  log(
    `\nruns ${counts.runs}, scored ${counts.scored}, voided ${counts.voided}, unscored ${counts.unscored}`,
  )
  const claims = claimCounts(db())
  log(
    `claims: ${claims.claimed} claimed, ${claims.terminal} unsettled on terminal conversations ` +
      `(since ${RESOURCE_CLAIM_MIGRATION}; historical runs are not backfilled)`,
  )
  const heldCandidates = db()
    .query(
      `SELECT worktree, MAX(keep_tree) keep_tree FROM run
      WHERE worktree IS NOT NULL AND status IN ('ok','failed','stale','stopped')
      GROUP BY worktree`,
    )
    .all() as { worktree: string; keep_tree: number }[]
  let explicitHolds = 0
  let dirtyHolds = 0
  for (const held of heldCandidates) {
    if (held.keep_tree) explicitHolds++
    else if (existsSync(held.worktree) && worktreeDirty(held.worktree).dirty) dirtyHolds++
  }
  log(
    `held worktrees ${explicitHolds + dirtyHolds} (${dirtyHolds} dirty, ${explicitHolds} --keep-tree)`,
  )
  const {
    projects: registeredProjects,
    undeclaredCommitHooks,
    registerBranchCheck,
  } = await import('./projects.ts')
  const hookFlags = registeredProjects().map(undeclaredCommitHooks).filter(Boolean)
  if (hookFlags.length) {
    log('\ncommit hooks skipped in worker trees; landing gate must declare the checks:')
    for (const line of hookFlags) log(`  ${line}`)
  }
  const registerQuestions = registeredProjects().flatMap((project) =>
    registerBranchCheck(project).problems.map((problem) => `${project.name}: ${problem}`),
  )
  if (registerQuestions.length) {
    log('\nregister questions (not run failures):')
    for (const question of registerQuestions) log(`  ${question}`)
  }
  const docker = dockerRunResources()
  const dockerResources = docker.ascertainable ? docker.resources : []
  const dockerOwnerIds = new Set(dockerResources.map(({ runId }) => runId))
  const owners = (
    db().query('SELECT id, repo, worktree, status FROM run').all() as {
      id: number
      repo: string | null
      worktree: string | null
      status: string
    }[]
  ).map((owner) => ({
    ...owner,
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
