import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { human } from '../../shared/interval.ts'
import { readMachineValue } from '../../shared/machine-config.ts'
import {
  ANSWERER_KIND_VALUES,
  ASKED_VIA_VALUES,
  QUESTION_DELIVERY_MODE_VALUES,
} from '../../shared/question-vocabulary.ts'
import { collectOnce, formatCollectLeg, releaseLease, watch, withLease } from './collect.ts'
import {
  formatMigrationRepairSummary,
  migrateDatabaseWithQuestionIdentityMap,
  nowIso,
  requireDatabase,
} from './db.ts'
import { hubDoctorLines } from './doctor.ts'
import { reclaimFixtureQuestions } from './fixture-question-reclaim.ts'
import { LocalHubAuth } from './local-auth.ts'
import {
  readQuestionIdentityMap,
  readWorkflowCursorIdentityMap,
  startDashboardCapability,
} from './orch.ts'
import { projects } from './projects.ts'
import { estateEngagedMs, tasksInWindow } from './query.ts'
import { printReconcile, reconcileOpenIntervals } from './reconcile.ts'
import {
  DEFAULT_STATS_DAYS,
  listOpenRulings,
  rulingsPayload,
  rulingsStatsPayload,
} from './rulings.ts'
import { serve } from './serve.ts'
import {
  checkServeDown,
  ownServeRecord,
  reportServeDown,
  stopRecordedServe,
} from './serve-lifecycle.ts'
import { startRevisionMonitor } from './service-revision.ts'
import { hoursAgo } from './time.ts'

async function collect(
  guard: import('./collect.ts').LeaseGuard | undefined,
  since?: string,
  only?: string,
) {
  const t0 = Date.now()
  const results = await collectOnce(since ?? hoursAgo(24 * 30), only, guard)
  for (const result of results) console.log(formatCollectLeg(result))
  console.log(`\ncollected in ${human(Date.now() - t0)}`)
  if (results.some((result) => !result.ok)) process.exitCode = 1
}

function printTasks(hours = '48'): void {
  const from = hoursAgo(Number(hours))
  const to = nowIso()
  const rows = tasksInWindow(from, to)
  if (!rows.length) {
    console.log(`nothing recorded in that window — run \`${PLATFORM_SLUG} record pull\` first`)
    return
  }
  const n = (value: number) => value.toLocaleString('en-US')
  console.log(
    `${'project'.padEnd(10)} ${'task'.padEnd(11)} ${'engaged'.padStart(9)} ` +
      `${'claude'.padStart(14)}  agents`,
  )
  for (const row of rows) {
    const vendors = row.vendors.map((vendor) => `${vendor.agent} ${n(vendor.tokens)}`).join(', ')
    const active = row.activeAgents.length ? `  <- ${row.activeAgents.join(', ')} running` : ''
    console.log(
      `${(row.project ?? '?').padEnd(10)} ${(row.key ?? '(untracked)').padEnd(11)} ` +
        `${human(row.engagedMs).padStart(9)} ${n(row.claudeTokens).padStart(14)}  ${vendors}${active}`,
    )
  }
  console.log(
    `\n${rows.length} rows. Estate engaged time over the window: ` +
      `${human(estateEngagedMs(from, to))} — the union across every task at once, ` +
      'which is why it is less than these rows added up.',
  )
}

function printRulingStats(days: number | undefined): void {
  const payload = days === undefined ? rulingsStatsPayload() : rulingsStatsPayload(days)
  const stats = payload.stats
  const wait = (value: number | null) => (value == null ? 'n/a' : human(value))
  const rate = (value: number | null) => (value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`)
  console.log(`ruling loop, last ${stats.window.days} days`)
  console.log(
    `questions asked: ${stats.questions_asked.total}  ` +
      ASKED_VIA_VALUES.map((via) => `${via} ${stats.questions_asked.by_asked_via[via]}`).join(
        '  ',
      ) +
      `  unknown ${stats.questions_asked.by_asked_via.unknown}`,
  )
  console.log(
    `answer wait: median ${wait(stats.answer_wait.overall.median_ms)}  ` +
      `p90 ${wait(stats.answer_wait.overall.p90_ms)}  ` +
      `under 5m ${stats.answer_wait.overall.under_5_minutes}  ` +
      `under 1h ${stats.answer_wait.overall.under_1_hour}  ` +
      `over 1h ${stats.answer_wait.overall.over_1_hour}`,
  )
  for (const kind of [...ANSWERER_KIND_VALUES, 'unknown'] as const) {
    const row = stats.answer_wait.by_answerer_kind[kind]
    console.log(`  ${kind}: ${row.count}  median ${wait(row.median_ms)}  p90 ${wait(row.p90_ms)}`)
  }
  for (const mode of QUESTION_DELIVERY_MODE_VALUES) {
    const row = stats.delivery.by_mode_and_outcome[mode]
    console.log(`delivery ${mode}: delivered ${row.delivered}  failed ${row.failed}`)
  }
  const resume = stats.delivery.stopped_turn.resume_share
  const retry = stats.delivery.stopped_turn.retry_share
  console.log(
    `stopped-turn delivery: resume ${stats.delivery.stopped_turn.resume}` +
      ` (${resume == null ? 'n/a' : `${(resume * 100).toFixed(1)}%`}), ` +
      `retry ${stats.delivery.stopped_turn.retry}` +
      ` (${retry == null ? 'n/a' : `${(retry * 100).toFixed(1)}%`})`,
  )
  console.log(
    `open: ${stats.open.count}  older than ${payload.stale_after}: ${stats.open.older_than_stale}`,
  )
  console.log(
    `operator answers: ${stats.operator_answers.count}  ` +
      `median wait ${wait(stats.operator_answers.median_wait_ms)}`,
  )
  console.log(`overturns: ${stats.overturns.count}  rate ${rate(stats.overturns.rate)}`)
  for (const kind of ['operator', 'agent'] as const)
    console.log(
      `  ${kind}: ${stats.overturns.by_answerer_kind[kind].count}  ` +
        `rate ${rate(stats.overturns.by_answerer_kind[kind].rate)}`,
    )
}

function registerCollectionCommands(program: Command): void {
  program
    .command('migrate')
    .description('apply pending checksummed schema migrations')
    .action(async () => {
      const migrated = await migrateDatabaseWithQuestionIdentityMap(
        readQuestionIdentityMap,
        readWorkflowCursorIdentityMap,
      )
      if (!migrated.versions.length) console.log(`schema already current: ${migrated.path}`)
      else {
        console.log(`migrated ${migrated.path}`)
        for (const version of migrated.versions) console.log(`  applied ${version}`)
      }
      const repairs = formatMigrationRepairSummary(migrated.repairs)
      if (repairs) console.log(repairs)
    })
  program
    .command('doctor')
    .description('report the live structural schema hash and user_version')
    .action(async () => {
      requireDatabase()
      for (const line of await hubDoctorLines()) console.log(line)
    })
  program
    .command('collect')
    .description('ingest every source into hub.db')
    .option('--since <ISO>', 'earliest source timestamp to ingest')
    .option('--only <runs|transcripts|git|tasks>', 'source to ingest')
    .option('--watch', 'keep collecting on a clock; what launchd runs')
    .action(async (options: { since?: string; only?: string; watch?: boolean }) => {
      requireDatabase()
      if (options.watch) {
        console.log(`hub: collecting every ${20}s (fast) and ${300}s (slow); ctrl-c to stop`)
        const holder = `collect:${process.pid}`
        let stop = async () => {}
        startRevisionMonitor(
          'collect',
          holder,
          () => stop(),
          () => releaseLease(holder),
        )
        stop = watch(holder, (error) => console.error(`hub: collect failed: ${error.message}`))
        await new Promise(() => {})
      }
      const result = await withLease(`collect:${process.pid}`, (guard) =>
        collect(guard, options.since, options.only),
      )
      if (!result.ran) {
        console.error(
          `hub: ${result.heldBy ?? 'another process'} is collecting and did not ` +
            'finish in 30s; nothing collected',
        )
        process.exitCode = 1
      }
    })
  program
    .command('tasks')
    .description('what has been worked on, newest window first')
    .option('--hours <N>', 'set the recent-work window in hours', '48')
    .action((options: { hours: string }) => {
      requireDatabase()
      printTasks(options.hours)
    })
}

function registerServeCommands(program: Command): void {
  program
    .command('login')
    .description('print a one-time local dashboard login URL')
    .option('--port <N>', 'dashboard port included in the login URL')
    .action((options: { port?: string }) =>
      console.log(
        new LocalHubAuth().mintLoginUrl(Number(options.port ?? readMachineValue('hub.port'))),
      ),
    )
  program
    .command('serve')
    .description('the dashboard')
    .option('--port <N>', 'port where the dashboard listens')
    .action((options: { port?: string }) => {
      requireDatabase()
      startDashboardCapability()
      const dashboard = serve(Number(options.port ?? readMachineValue('hub.port')))
      if (dashboard.port === undefined) throw new Error('hub: dashboard did not bind a TCP port')
      ownServeRecord(dashboard.port)
    })
  program
    .command('serve-stop')
    .description("stop this checkout's recorded dashboard")
    .option('--port <N>', 'port of the recorded dashboard to stop')
    .action(async (options: { port?: string }) => {
      const port = Number(options.port)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        console.error(`usage: ${PLATFORM_SLUG} dashboard stop --port N`)
        process.exitCode = 2
      } else if (!(await stopRecordedServe(port))) process.exitCode = 1
    })
  program
    .command('serve-check')
    .description("confirm this checkout's dashboard is not serving on N")
    .option('--port <N>', 'port to inspect for a recorded dashboard')
    .option('--down', 'require the recorded dashboard to be stopped')
    .action(async (options: { port?: string; down?: boolean }) => {
      const port = Number(options.port)
      if (!options.down || !Number.isInteger(port) || port < 1 || port > 65_535) {
        console.error(`usage: ${PLATFORM_SLUG} dashboard check --port N --down`)
        process.exitCode = 2
      } else if (!reportServeDown(port, await checkServeDown(port))) process.exitCode = 1
    })
}

function registerMaintenanceCommands(program: Command): void {
  program
    .command('reconcile')
    .description('close open intervals whose orchestrator runs are terminal using exact run ids')
    .option('--dry-run', 'report interval closures without writing them')
    .action(async (options: { dryRun?: boolean }) => {
      requireDatabase()
      printReconcile(await reconcileOpenIntervals({ dryRun: Boolean(options.dryRun) }))
    })
  program
    .command('reclaim-fixture-questions')
    .description('remove question, interval and task rows left by the documented gate fixtures')
    .option('--dry-run', 'report fixture rows without removing them')
    .option('--json', 'write the reclaimed fixture rows as JSON')
    .action(async (options: { dryRun?: boolean; json?: boolean }) => {
      requireDatabase()
      const registered = new Set(projects().map((project) => project.name))
      const { rows, intervals, tasks } = await reclaimFixtureQuestions(
        Boolean(options.dryRun),
        registered,
      )
      if (options.json) console.log(JSON.stringify({ rows, intervals, tasks }))
      else {
        const verb = options.dryRun ? 'would remove' : 'removed'
        for (const row of rows)
          console.log(`${verb} question ${row.question_id} ${row.session_id} ${row.run_ref}`)
        for (const interval of intervals)
          console.log(`${verb} interval ${interval.record_id} ${interval.ref}`)
        for (const task of tasks)
          console.log(`${verb} task ${task.key} ${task.project} ${task.title}`)
      }
    })
}

function registerRulingCommands(program: Command): void {
  program
    .command('rulings')
    .description('open questions ingested from orch, with age')
    .option('--json', 'one JSON document: {stale_after, questions}')
    .option('--stats', 'report ruling-loop measurements instead of open questions')
    .option('--days <N>', 'measure rulings over this many days', String(DEFAULT_STATS_DAYS))
    .action((options: { json?: boolean; stats?: boolean; days: string }) => {
      requireDatabase()
      if (options.stats) {
        const days = Number(options.days)
        if (!Number.isInteger(days) || days <= 0)
          throw new Error('--days must be a positive integer')
        if (options.json) console.log(JSON.stringify(rulingsStatsPayload(days)))
        else printRulingStats(days)
        return
      }
      if (options.json) {
        console.log(JSON.stringify(rulingsPayload()))
        return
      }
      const rows = listOpenRulings()
      if (!rows.length) console.log('no open rulings')
      else
        for (const row of rows)
          console.log(
            `question ${row.question_id}  ${(row.task_key ?? '(untracked)').padEnd(12)} ` +
              `session ${row.session_id ?? 'unknown'}  since ${row.asked_at}  age ${human(row.age)}`,
          )
    })
}

export function registerCoreCommands(program: Command): void {
  registerCollectionCommands(program)
  registerServeCommands(program)
  registerMaintenanceCommands(program)
  registerRulingCommands(program)
}
