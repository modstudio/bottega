#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { human } from '../../shared/interval.ts'
import { readMachineValue } from '../../shared/machine-config.ts'
import {
  ANSWERER_KIND_VALUES,
  ASKED_VIA_VALUES,
  QUESTION_DELIVERY_MODE_VALUES,
} from '../../shared/question-vocabulary.ts'
import { type TrackerProtocol, trackerCreatedTaskKey } from '../../shared/trackers.ts'
import { projectOf } from './attribute.ts'
import { collectOnce, releaseLease, watch, withLease } from './collect.ts'
import {
  formatMigrationRepairSummary,
  migrateDatabase,
  nowIso,
  requireDatabase,
  writeTransaction,
} from './db.ts'
import { hubDoctorLines } from './doctor.ts'
import { reclaimFixtureQuestions } from './fixture-question-reclaim.ts'
import { LocalHubAuth } from './local-auth.ts'
import { credentials, Mcp } from './mcp.ts'
import {
  acknowledgeNote,
  createNote,
  curateNotes,
  curatorEnabled,
  dropNote,
  listActionableNotes,
  listNotes,
  mergeNote,
  noteSessionId,
  promoteNote,
  setCuratorEnabled,
  staleNotes,
} from './note.ts'
import { pushNotes } from './note-push.ts'
import { startDashboardCapability } from './orch.ts'
import { projects } from './projects.ts'
import { estateEngagedMs, tasksInWindow } from './query.ts'
import { printReconcile, reconcileOpenIntervals } from './reconcile.ts'
import { runReportCommand } from './report-cli.ts'
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
import { printSyncResult, syncEvidence } from './sync.ts'
import {
  commentTask,
  createTask,
  createTaskDocument,
  DuplicateTaskError,
  deleteTaskDocument,
  duplicateCandidates,
  getTaskDocument,
  listTaskDocuments,
  listTasks,
  setTask,
  showTask,
  updateTaskDocument,
} from './task.ts'
import { closeThenPrune } from './task-close.ts'
import {
  type ParsedTaskArguments,
  parseTaskArguments,
  taskCommandShapes,
  taskHelpRequested,
} from './task-command-arguments.ts'
import { runHostedTaskMaintenance } from './task-hosted-cli.ts'
import { hoursAgo } from './time.ts'
import { createAdvertisedTrackerTask } from './tracker-new.ts'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const flags = (name: string) =>
  argv.flatMap((value, index) =>
    value === `--${name}` && argv[index + 1] ? [argv[index + 1]!] : [],
  )
const has = (name: string) => argv.includes(`--${name}`)
const isHelpToken = (token: string | undefined) =>
  token === 'help' || token === '--help' || token === '-h'
const hubHelpRequested = () => {
  if (cmd === 'task') return taskHelpRequested(argv)
  if (isHelpToken(cmd) || argv[1] === 'help') return true
  const valueFlags = new Set([
    '--area',
    '--hours',
    '--only',
    '--parent',
    '--port',
    '--project',
    '--reason',
    '--role',
    '--same-as',
    '--session',
    '--since',
    '--status',
    '--title',
    '--body',
    '--body-file',
    '--days',
    '--version',
  ])
  let expectingValue = false
  for (const token of argv.slice(1)) {
    if (expectingValue) {
      expectingValue = false
      continue
    }
    if (token === '--help' || token === '-h') return true
    expectingValue = valueFlags.has(token)
  }
  return false
}

const TASK_USAGE = `hub task new --project X --title "..." [--status Y] [--parent KEY]
               [--body "..."|--body-file PATH] [--allow-duplicate "reason"]
  hub task duplicates --project X --title "..." --json
  hub task list [--project X] [--status Y] [--parent KEY] [--json]
  hub task show <KEY> [--project X] [--json]
  hub task set <KEY> [--project X] [--title "..."] [--status Y] [--parent KEY|--no-parent]
               [--body "..."] [--assignee NAME] [--force]
  hub task close <KEY> [--project X] [--keep-branches]
  hub task comment <KEY> "..." [--project X]
  hub task tracker-new --project X --title "..." --body "..."
  hub task doc new <KEY> [--project X] --title "..." [--role handoff]
               [--body "..."|--body-file PATH]
  hub task doc list <KEY> [--project X] [--json]
  hub task doc show <ID> [--json]
  hub task doc set <ID> [--title "..."] [--role handoff|--no-role]
               [--body "..."|--body-file PATH] [--version TOKEN]
  hub task doc rm <ID>
  hub task import <file.json> backfill from a clustered commit history
  hub task push [--dry-run]   migrate and verify the local task cache
  hub task prune-foreign [--dry-run] [--confirm N] [--project NAME] [--only-present-elsewhere] [--json]`

function validatedTaskArguments(): ParsedTaskArguments | undefined {
  const verb = argv[1]
  const hasAction = verb === 'doc' || verb === 'document'
  const action = hasAction ? argv[2] : undefined
  const command = hasAction ? `${verb} ${action}` : verb
  const commandShape = taskCommandShapes.get(command ?? '')
  if (!commandShape) return undefined
  const result = parseTaskArguments(argv.slice(hasAction ? 3 : 2), commandShape)
  if (!result.ok) throw new Error(result.refusal)
  return result.arguments
}

function taskArgumentReaders(parsed: ParsedTaskArguments | undefined) {
  return {
    taskFlag: (name: string) => parsed?.values.get(`--${name}`),
    taskHas: (name: string) =>
      parsed?.values.has(`--${name}`) === true || parsed?.booleans.has(`--${name}`) === true,
  }
}

const USAGE = `hub — every project's tasks in flight, what each cost, and scheduled reports

  hub --version               identify this release or development checkout
  hub collect [--since ISO] [--only runs|transcripts|git|tasks]
                              ingest every source into hub.db
      --watch                 keep collecting on a clock; what launchd runs.
                              Safe beside a running dashboard: a lease in the
                              database means only one process collects.
  hub migrate                 apply pending checksummed schema migrations
  hub sync [--dry-run]        push changed local evidence to the hosted hub
  hub doctor                  report the live structural schema hash and user_version
  hub tasks [--hours N]       what has been worked on, newest window first
  hub login [--port 7778]     print a one-time local dashboard login URL
  hub serve [--port 7778]     the dashboard
  hub serve-stop --port N     stop this checkout's recorded dashboard
  hub serve-check --port N --down
                              confirm this checkout's dashboard is not serving on N
  hub reconcile [--dry-run]   close open intervals whose orch runs are terminal
                              using exact run ids, never an age or time window
  hub rulings [--json]        open questions ingested from orch, with age
      --json                  one JSON document: {stale_after, questions}
  hub rulings --stats [--days N] [--json]
                              ruling-loop measures for the last N days (default ${DEFAULT_STATS_DAYS})
  hub reclaim-fixture-questions [--dry-run] [--json]
                              remove question, interval and task rows left by the documented gate fixtures

  ${TASK_USAGE}

  hub note new "<text>" [--same-as ID|--new] [--area AREA]
  hub note list [--project X] [--stale] [--session ID] [--actionable|--kept] [--json]
  hub note same <ID> <ID>
  hub note keep <ID>...
  hub note promote <ID>
  hub note drop <ID> --reason "..."
  hub note stale              mark vanished anchors and reap eligible notes
  hub note curate [--scheduled]
  hub note curator [--enable|--disable]
  hub note push [--dry-run]   migrate and verify the local note cache

  hub report subscribe --scope space|project|person [--project NAME] --cadence daily|weekly
                              --hour N [--day monday] --zone AREA/CITY [--recipient USER_ID]
  hub report subscriptions [--json]
  hub report unsubscribe <ID>
  hub report send [--dry-run]  render and send every subscription whose period is due
  hub report push [--dry-run] migrate and verify send history

Engaged time is the UNION of every agent's working spans: a session waiting on a
delegated agent is not idle, and two agents running at once did not take twice
as long.
`

async function collect() {
  const since = flag('since') ?? hoursAgo(24 * 30)
  const only = flag('only')
  const t0 = Date.now()
  const results = await collectOnce(since, only)
  for (const result of results)
    console.log(`${result.source.padEnd(18)}${result.ok ? 'ok' : `FAILED: ${result.error}`}`)
  console.log(`\ncollected in ${human(Date.now() - t0)}`)
  if (results.some((result) => !result.ok)) process.exitCode = 1
}

function tasks() {
  const hours = Number(flag('hours') ?? 48)
  const from = hoursAgo(hours)
  const to = nowIso()
  const rows = tasksInWindow(from, to)
  if (!rows.length) {
    console.log('nothing recorded in that window — run `hub collect` first')
    return
  }

  const n = (x: number) => x.toLocaleString('en-US')
  console.log(
    `${'project'.padEnd(10)} ${'task'.padEnd(11)} ${'engaged'.padStart(9)} ` +
      `${'claude'.padStart(14)}  agents`,
  )
  for (const r of rows) {
    const vendors = r.vendors.map((v) => `${v.agent} ${n(v.tokens)}`).join(', ')
    const active = r.activeAgents.length ? `  <- ${r.activeAgents.join(', ')} running` : ''
    console.log(
      `${(r.project ?? '?').padEnd(10)} ${(r.key ?? '(untracked)').padEnd(11)} ` +
        `${human(r.engagedMs).padStart(9)} ${n(r.claudeTokens).padStart(14)}  ${vendors}${active}`,
    )
  }
  console.log(
    `\n${rows.length} rows. Estate engaged time over the window: ` +
      `${human(estateEngagedMs(from, to))} — the union across every task at once, ` +
      `which is why it is less than these rows added up.`,
  )
}

async function importTasks(file: string) {
  const project = projectOf(fileURLToPath(new URL('../..', import.meta.url)))
  const registered = projects().find((candidate) => candidate.name === project)
  const prefix = registered?.settings.keyPrefixes?.[0]
  if (!project || !prefix) throw new Error('the local project must declare a key prefix')
  const items = JSON.parse(readFileSync(file, 'utf8')) as {
    title: string
    opened: string
    closed: string | null
    shas: string[]
  }[]
  const log = Bun.spawnSync(
    [
      'git',
      '-C',
      fileURLToPath(new URL('../..', import.meta.url)),
      'log',
      '--all',
      '--format=%H%x09%cI',
    ],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  const stamps = new Map(
    new TextDecoder()
      .decode(log.stdout)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t') as [string, string]),
  )
  const imported: Array<{ key: string; shas: string[] }> = []
  for (const item of items) {
    const done = !!item.closed
    const row = await createTask(
      {
        project,
        title: item.title,
        status: done ? 'done' : 'open',
        openedAt: item.opened,
        closedAt: item.closed,
      },
      { skipDuplicateCheck: true },
    )
    imported.push({ key: row.key, shas: item.shas })
  }
  writeTransaction((conn) => {
    for (const item of imported) {
      for (const sha of item.shas) {
        const at = stamps.get(sha)
        if (!at) continue
        conn
          .query(`INSERT OR IGNORE INTO commit_key (sha, repo, task_key, at) VALUES (?,?,?,?)`)
          .run(sha, project, item.key, at)
      }
    }
  })
  console.log(`imported ${items.length} tasks`)
}

async function createTaskCommand(
  required: (name: string) => string,
  newBody: () => string | undefined,
  taskFlag: (name: string) => string | undefined,
  taskHas: (name: string) => boolean,
) {
  const project = required('project')
  const title = required('title')
  const body = newBody()
  const override = taskFlag('allow-duplicate')
  const delay = Number(process.env.HUB_TEST_DUPLICATE_DELAY_MS ?? 0)
  const afterDuplicateSearch =
    delay > 0
      ? () => {
          const marker = process.env.HUB_TEST_DUPLICATE_MARKER
          if (marker) writeFileSync(marker, '')
          Bun.sleepSync(delay)
        }
      : undefined
  try {
    const row = await createTask(
      { project, title, status: taskFlag('status'), parent: taskFlag('parent'), body },
      {
        allowDuplicateReason: taskHas('allow-duplicate') ? override : undefined,
        afterDuplicateSearch,
      },
    )
    console.log(row.key)
  } catch (error) {
    if (!(error instanceof DuplicateTaskError)) throw error
    throw new Error(
      [
        'possible duplicate tasks:',
        ...error.candidates.map(
          (candidate) =>
            `${candidate.key} [${candidate.status ?? 'unknown'}] score ${candidate.score.toFixed(3)}  ${candidate.title}`,
        ),
        '',
        'Refusing to create a duplicate. Pass --allow-duplicate "reason" to override.',
      ].join('\n'),
    )
  }
}

async function task(parsed: ParsedTaskArguments | undefined) {
  const sub = argv[1]
  if (taskHelpRequested(argv)) {
    console.log(TASK_USAGE)
    return
  }
  const { taskFlag, taskHas } = taskArgumentReaders(parsed)
  const required = (name: string) => {
    const value = taskFlag(name)
    if (value === undefined || !value.trim()) throw new Error(`--${name} is required`)
    return value
  }
  const printRow = (row: ReturnType<typeof showTask>['task']) => {
    console.log(
      `${row.key.padEnd(10)} ${(row.status_category ?? '').padEnd(8)} ` +
        `${row.project.padEnd(12)} ${row.title ?? ''}`,
    )
  }

  async function closeAndPruneTask(key: string) {
    const { closed, pruned, pruneError } = await closeThenPrune(
      key,
      { project: taskFlag('project') },
      taskHas('keep-branches'),
      {},
    )
    printRow(closed)
    if (pruneError) {
      console.error(`branch prune failed: ${pruneError.message}`)
      console.error(`retry: orch branches prune --project ${closed.project} --key ${closed.key}`)
      process.exitCode = 1
      return
    }
    if (!pruned) return
    console.log(`branches: deleted ${pruned.deleted.length}; kept ${pruned.kept.length}`)
    for (const branch of pruned.operator) {
      console.log(
        `${branch.state}: ${branch.branch} (${branch.commitsNotOnTrunk} commits not on trunk); ${branch.command}`,
      )
    }
  }
  const newBody = () => {
    if (taskHas('body') && taskHas('body-file')) {
      throw new Error('--body and --body-file are mutually exclusive')
    }
    if (taskHas('body-file')) return readFileSync(required('body-file'), 'utf8')
    if (taskHas('body')) return required('body')
    return undefined
  }

  if (sub === 'doc' || sub === 'document') {
    const action = argv[2]
    const ref = parsed?.positionals[0] ?? ''
    if (action === 'new') {
      const document = await createTaskDocument(
        {
          task: ref,
          title: required('title'),
          body: newBody(),
          role: taskFlag('role'),
        },
        { project: taskFlag('project') },
      )
      // This is a value for the caller to pass back, not presentational output.
      // Bun inspects a numeric console argument and ANSI-wraps it when
      // FORCE_COLOR is set, even when NO_COLOR is set too.
      console.log(String(document.id))
      return
    }
    if (action === 'list') {
      const documents = listTaskDocuments(ref, { project: taskFlag('project') })
      if (taskHas('json')) console.log(JSON.stringify(documents))
      else if (!documents.length) console.log('no documents')
      else
        for (const document of documents) {
          const role = document.role ? ` [${document.role}]` : ''
          console.log(`${document.id}${role}  ${document.title}`)
        }
      return
    }
    if (action === 'show') {
      const document = getTaskDocument(ref)
      if (taskHas('json')) console.log(JSON.stringify(document))
      else {
        console.log(
          `${document.id}  ${document.task_key}${document.role ? ` [${document.role}]` : ''}  ${document.title}`,
        )
        console.log(`version: ${document.version}`)
        if (document.body) console.log(`\n${document.body}`)
      }
      return
    }
    if (action === 'set') {
      if (taskHas('role') && taskHas('no-role'))
        throw new Error('--role and --no-role are mutually exclusive')
      const body = newBody()
      const changes = {
        ...(taskHas('title') ? { title: required('title') } : {}),
        ...(taskHas('role')
          ? { role: required('role') }
          : taskHas('no-role')
            ? { role: null }
            : {}),
        ...(body !== undefined ? { body } : {}),
        ...(taskHas('version') ? { expectedVersion: required('version') } : {}),
      }
      if (!Object.keys(changes).length)
        throw new Error('hub task doc set requires a field to change')
      const document = await updateTaskDocument(ref, changes)
      console.log(`${document.id} updated; version ${document.version}`)
      return
    }
    if (action === 'rm') {
      const document = await deleteTaskDocument(ref)
      console.log(`${document.id} removed from ${document.task_key}`)
      return
    }
    throw new Error('hub task doc: expected new | list | show | set | rm')
  }

  if (sub === 'new') {
    await createTaskCommand(required, newBody, taskFlag, taskHas)
    return
  }
  if (sub === 'duplicates') {
    const rows = duplicateCandidates(listTasks({ project: required('project') }), required('title'))
    if (!taskHas('json')) throw new Error('hub task duplicates requires --json')
    console.log(JSON.stringify(rows))
    return
  }
  if (sub === 'tracker-new') {
    const project = projects().find((candidate) => candidate.name === required('project'))
    if (!project) throw new Error(`unknown project '${required('project')}'`)
    const tracker = project.settings.tracker
    const env = tracker?.envPrefix ?? project.settings.envPrefix
    if (!tracker || !env)
      throw new Error(`project ${project.name} has no usable tracker configured`)
    const auth = await credentials(env)
    if (!auth) throw new Error(`credentials for ${project.name} tracker do not resolve`)
    const status = tracker.openStatuses?.[0]
    if (!status) throw new Error(`project ${project.name} has no open tracker status configured`)
    const client = new Mcp(auth.url, auth.token)
    await client.initialize()
    const result = await createAdvertisedTrackerTask(client, project, {
      title: required('title'),
      body: required('body'),
      status,
    })
    const key = trackerCreatedTaskKey(tracker.protocol as TrackerProtocol, result)
    if (!key) {
      throw new Error(`tracker created a task but returned no task key: ${JSON.stringify(result)}`)
    }
    console.log(key)
    return
  }
  if (sub === 'list') {
    const rows = listTasks({
      project: taskFlag('project'),
      status: taskFlag('status'),
      parent: taskFlag('parent'),
    })
    if (taskHas('json')) console.log(JSON.stringify(rows))
    else if (!rows.length) console.log('no tasks')
    else rows.forEach(printRow)
    return
  }
  if (sub === 'show') {
    const shown = showTask(parsed?.positionals[0] ?? '', { project: taskFlag('project') })
    if (taskHas('json')) console.log(JSON.stringify(shown))
    else {
      printRow(shown.task)
      if (shown.task.parent_key) console.log(`parent: ${shown.task.parent_key}`)
      if (shown.task.body) console.log(`\n${shown.task.body}`)
      if (shown.documents.length) {
        console.log('\ndocuments:')
        for (const document of shown.documents) {
          const role = document.role ? ` [${document.role}]` : ''
          console.log(
            `  ${document.id}${role}  ${document.title} — hub task doc show ${document.id}`,
          )
        }
      }
      for (const comment of shown.comments) console.log(`\n${comment.created_at}  ${comment.body}`)
    }
    return
  }
  if (sub === 'set') {
    if (taskHas('parent') && taskHas('no-parent'))
      throw new Error('--parent and --no-parent are mutually exclusive')
    const changes = {
      ...(taskHas('title') ? { title: required('title') } : {}),
      ...(taskHas('status') ? { status: required('status') } : {}),
      ...(taskHas('parent')
        ? { parent: required('parent') }
        : taskHas('no-parent')
          ? { parent: null }
          : {}),
      ...(taskHas('body') ? { body: required('body') } : {}),
      ...(taskHas('assignee') ? { assignee: required('assignee') } : {}),
    }
    if (!Object.keys(changes).length) throw new Error('hub task set requires a field to change')
    printRow(
      await setTask(parsed?.positionals[0] ?? '', { project: taskFlag('project') }, changes, {
        force: taskHas('force'),
      }),
    )
    return
  }
  if (sub === 'close') {
    await closeAndPruneTask(parsed?.positionals[0] ?? '')
    return
  }
  if (sub === 'comment') {
    const body = parsed?.positionals[1]
    if (!body) throw new Error('hub task comment <KEY> "..."')
    const comment = await commentTask(
      parsed?.positionals[0] ?? '',
      { project: taskFlag('project') },
      body,
    )
    console.log(`${comment.task_key} commented ${comment.created_at}`)
    return
  }
  if (sub === 'import') {
    const file = parsed?.positionals[0]
    if (!file) throw new Error('hub task import <file.json>')
    await importTasks(file)
    return
  }
  if (sub === 'push' || sub === 'prune-foreign') return runHostedTaskMaintenance(sub, argv)
  throw new Error('hub task <new|list|show|set|close|comment|import|push|prune-foreign>')
}

async function note() {
  const sub = argv[1]
  refuseAmbiguousNoteVerb(sub)
  if (sub === 'push') return pushNoteCache()
  if (sub === 'list') {
    if (argv[2] && !argv[2]!.startsWith('--')) {
      throw new Error('to file the text "list", use: hub note new "list" [--new|--same-as ID]')
    }
    if (has('actionable') && has('kept'))
      throw new Error('--actionable and --kept are mutually exclusive')
    const sessions = flags('session')
    if (has('kept') && !sessions.length && noteSessionId()) sessions.push(noteSessionId()!)
    if (has('kept') && !sessions.length)
      throw new Error('hub note list --kept requires --session ID or a session environment')
    const session = sessions.length ? sessions : undefined
    const rows = has('actionable')
      ? listActionableNotes({ project: flag('project'), session })
      : listNotes({ project: flag('project'), stale: has('stale'), session, kept: has('kept') })
    if (has('json')) console.log(JSON.stringify(rows))
    else if (!rows.length) console.log('no notes')
    else
      for (const row of rows) {
        console.log(
          `${String(row.id).padEnd(5)} ${row.project.padEnd(12)} x${row.sightings}  ${row.text}`,
        )
      }
    return
  }
  if (sub === 'keep') {
    const ids = argv.slice(2).filter((value) => !value.startsWith('--'))
    if (!ids.length) throw new Error('hub note keep <id>...')
    const session = noteSessionId()
    if (!session) throw new Error('hub note keep requires a session environment')
    for (const id of ids) {
      const result = await acknowledgeNote(id, session)
      console.log(
        `note ${result.note.id} ${result.alreadyAcknowledged ? 'already kept' : 'kept'} for this session`,
      )
    }
    return
  }
  if (sub === 'same') {
    const row = await mergeNote(argv[2] ?? '', argv[3] ?? '')
    console.log(`note ${row.id} now has ${row.sightings} sightings`)
    return
  }
  if (sub === 'promote') {
    const row = await promoteNote(argv[2] ?? '')
    console.log(`${row.promoted_task}`)
    return
  }
  if (sub === 'drop') {
    const reason = flag('reason')
    if (!reason) throw new Error('hub note drop <id> --reason "..."')
    const row = await dropNote(argv[2] ?? '', reason)
    console.log(`note ${row.id} dropped: ${row.stale_reason}`)
    return
  }
  if (sub === 'stale') {
    const result = await staleNotes()
    for (const row of result.reasons) console.log(`note ${row.id}: ${row.reason}`)
    console.log(`${result.marked} marked stale; ${result.deleted} deleted`)
    return
  }
  if (sub === 'curate') {
    const results = await curateNotes(has('scheduled'))
    if (has('scheduled') && !curatorEnabled()) {
      console.log('note curator is disabled')
      return
    }
    for (const result of results) console.log(`${result.project}: ${result.result}`)
    return
  }
  if (sub === 'curator') {
    if (has('enable') === has('disable')) {
      console.log(`note curator is ${curatorEnabled() ? 'enabled' : 'disabled'}`)
      return
    }
    console.log(`note curator ${setCuratorEnabled(has('enable')) ? 'enabled' : 'disabled'}`)
    return
  }
  if (sub !== 'new') {
    throw new Error(
      `hub note new <text> [--same-as ID|--new]; to file the text "${sub ?? ''}", put new before it`,
    )
  }
  const text = argv[2] ?? ''
  const same = flag('same-as')
  let result = await createNote({
    text,
    area: flag('area'),
    sameAs: same ? Number(same) : undefined,
    forceNew: has('new'),
  })
  if (!result.note) {
    const lines = result.candidates.map(
      (candidate) => `${candidate.id} score ${candidate.score.toFixed(3)}  ${candidate.text}`,
    )
    if (!process.stdin.isTTY) {
      throw new Error(
        `possible duplicate notes:\n${lines.join('\n')}\nPass --same-as <id> or --new.`,
      )
    }
    console.log(`possible duplicate notes:\n${lines.join('\n')}`)
    const answer = prompt("Enter a note id for the same finding, or 'new':")?.trim() ?? ''
    result = /^\d+$/.test(answer)
      ? await createNote({ text, area: flag('area'), sameAs: Number(answer) })
      : answer === 'new'
        ? await createNote({ text, area: flag('area'), forceNew: true })
        : result
    if (!result.note) throw new Error('note not filed')
  }
  for (const candidate of result.candidates) {
    console.log(`near ${candidate.id} score ${candidate.score.toFixed(3)}  ${candidate.text}`)
  }
  console.log(
    `note ${result.note.id} filed; ${result.note.sightings} sighting${result.note.sightings === 1 ? '' : 's'}`,
  )
}

function refuseAmbiguousNoteVerb(sub: string | undefined): void {
  const verbs = new Set([
    'list',
    'same',
    'keep',
    'promote',
    'drop',
    'stale',
    'curate',
    'curator',
    'push',
  ])
  if (sub && verbs.has(sub) && (has('new') || flag('same-as'))) {
    throw new Error(`to file the text "${sub}", use: hub note new "${sub}" [--new|--same-as ID]`)
  }
}

async function pushNoteCache(): Promise<void> {
  const result = await pushNotes({ dryRun: has('dry-run') })
  console.log(JSON.stringify(result, null, 2))
  if (result.match === false) process.exitCode = 1
}

/**
 * Every command's errors are the caller's message, not a stack trace.
 *
 * `hub task new` for a project with no key prefix raises a deliberately helpful
 * error naming the exact `orch project set` that fixes it — and it reached the
 * terminal as eight lines of Bun source context with the sentence buried at the
 * bottom. The message was right and unreadable, which is the same as wrong.
 *
 * orch has wrapped its dispatch this way for exactly this reason; hub had not.
 */
try {
  if (hubHelpRequested()) {
    console.log(cmd === 'task' ? TASK_USAGE : USAGE)
    process.exit(0)
  }

  const taskArguments = cmd === 'task' ? validatedTaskArguments() : undefined

  const usesDatabase =
    cmd === 'collect' ||
    cmd === 'sync' ||
    cmd === 'tasks' ||
    cmd === 'serve' ||
    (cmd === 'task' && argv[1] !== 'prune-foreign') ||
    cmd === 'send' ||
    cmd === 'report' ||
    cmd === 'reconcile' ||
    cmd === 'rulings' ||
    cmd === 'doctor' ||
    cmd === 'note'
  if (usesDatabase) requireDatabase()

  switch (cmd) {
    case 'migrate': {
      const migrated = migrateDatabase()
      if (migrated.versions.length === 0) console.log(`schema already current: ${migrated.path}`)
      else {
        console.log(`migrated ${migrated.path}`)
        for (const version of migrated.versions) console.log(`  applied ${version}`)
      }
      const repairSummary = formatMigrationRepairSummary(migrated.repairs)
      if (repairSummary) console.log(repairSummary)
      break
    }
    case 'doctor':
      for (const line of hubDoctorLines()) console.log(line)
      break
    case 'collect':
      if (has('watch')) {
        console.log(`hub: collecting every ${20}s (fast) and ${300}s (slow); ctrl-c to stop`)
        const holder = `collect:${process.pid}`
        let stop = async () => {}
        startRevisionMonitor(
          'collect',
          holder,
          () => stop(),
          () => releaseLease(holder),
        )
        stop = watch(holder, (e) => console.error(`hub: collect failed: ${e.message}`))
        // Hold the process open for launchd, which restarts anything that exits.
        await new Promise(() => {})
      }
      {
        // Through the lease, not around it. This used to call collect() directly,
        // which let it interleave with `hub serve` and the launchd daemon while
        // the transcripts leg was clearing and rewriting spans.
        const r = await withLease(`collect:${process.pid}`, collect)
        if (!r.ran) {
          console.error(
            `hub: ${r.heldBy ?? 'another process'} is collecting and did not ` +
              'finish in 30s; nothing collected',
          )
          process.exit(1)
        }
      }
      break
    case 'sync':
      printSyncResult(await syncEvidence({ dryRun: has('dry-run') }))
      break
    case 'tasks':
      tasks()
      break
    case 'login': {
      const port = Number(flag('port') ?? readMachineValue('hub.port'))
      console.log(new LocalHubAuth().mintLoginUrl(port))
      break
    }
    case 'serve': {
      startDashboardCapability()
      const dashboard = serve(Number(flag('port') ?? readMachineValue('hub.port')))
      if (dashboard.port === undefined) throw new Error('hub: dashboard did not bind a TCP port')
      ownServeRecord(dashboard.port)
      break
    }
    case 'serve-stop': {
      const port = Number(flag('port'))
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        console.error('usage: hub serve-stop --port N')
        process.exitCode = 2
        break
      }
      if (!(await stopRecordedServe(port))) process.exitCode = 1
      break
    }
    case 'serve-check': {
      const port = Number(flag('port'))
      if (!has('down') || !Number.isInteger(port) || port < 1 || port > 65_535) {
        console.error('usage: hub serve-check --port N --down')
        process.exitCode = 2
        break
      }
      const decision = await checkServeDown(port)
      if (!reportServeDown(port, decision)) process.exitCode = 1
      break
    }
    case 'reconcile':
      printReconcile(await reconcileOpenIntervals({ dryRun: has('dry-run') }))
      break
    case 'reclaim-fixture-questions': {
      const registeredProjects = new Set(projects().map((project) => project.name))
      const { rows, intervals, tasks } = await reclaimFixtureQuestions(
        has('dry-run'),
        registeredProjects,
      )
      if (has('json')) console.log(JSON.stringify({ rows, intervals, tasks }))
      else {
        const verb = has('dry-run') ? 'would remove' : 'removed'
        for (const row of rows)
          console.log(`${verb} question ${row.question_id} ${row.session_id} ${row.run_ref}`)
        for (const interval of intervals)
          console.log(`${verb} interval ${interval.id} ${interval.ref}`)
        for (const task of tasks)
          console.log(`${verb} task ${task.key} ${task.project} ${task.title}`)
      }
      break
    }
    case 'rulings': {
      if (has('stats')) {
        const rawDays = flag('days')
        const days = rawDays == null ? undefined : Number(rawDays)
        if (days !== undefined && (!Number.isInteger(days) || days <= 0))
          throw new Error('--days must be a positive integer')
        const payload = days === undefined ? rulingsStatsPayload() : rulingsStatsPayload(days)
        if (has('json')) {
          console.log(JSON.stringify(payload))
          break
        }
        const stats = payload.stats
        const wait = (value: number | null) => (value == null ? 'n/a' : human(value))
        console.log(`ruling loop, last ${stats.window.days} days`)
        console.log(
          `questions asked: ${stats.questions_asked.total}  ` +
            ASKED_VIA_VALUES.map((via) => `${via} ${stats.questions_asked.by_asked_via[via]}`).join(
              '  ',
            ) +
            `  ` +
            `unknown ${stats.questions_asked.by_asked_via.unknown}`,
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
          console.log(
            `  ${kind}: ${row.count}  median ${wait(row.median_ms)}  p90 ${wait(row.p90_ms)}`,
          )
        }
        for (const mode of QUESTION_DELIVERY_MODE_VALUES) {
          const row = stats.delivery.by_mode_and_outcome[mode]
          console.log(`delivery ${mode}: delivered ${row.delivered}  failed ${row.failed}`)
        }
        const resumeShare = stats.delivery.stopped_turn.resume_share
        const retryShare = stats.delivery.stopped_turn.retry_share
        console.log(
          `stopped-turn delivery: resume ${stats.delivery.stopped_turn.resume}` +
            ` (${resumeShare == null ? 'n/a' : `${(resumeShare * 100).toFixed(1)}%`}), ` +
            `retry ${stats.delivery.stopped_turn.retry}` +
            ` (${retryShare == null ? 'n/a' : `${(retryShare * 100).toFixed(1)}%`})`,
        )
        console.log(
          `open: ${stats.open.count}  older than ${payload.stale_after}: ${stats.open.older_than_stale}`,
        )
        console.log(
          `operator answers: ${stats.operator_answers.count}  ` +
            `median wait ${wait(stats.operator_answers.median_wait_ms)}`,
        )
        const rate = (value: number | null) =>
          value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`
        console.log(`overturns: ${stats.overturns.count}  rate ${rate(stats.overturns.rate)}`)
        // biome-ignore format: keep this frozen command adapter below its file ceiling.
        for (const kind of ['operator', 'agent'] as const) {
          console.log(`  ${kind}: ${stats.overturns.by_answerer_kind[kind].count}  rate ${rate(stats.overturns.by_answerer_kind[kind].rate)}`)
        }
        break
      }
      if (has('json')) {
        console.log(JSON.stringify(rulingsPayload()))
        break
      }
      const rows = listOpenRulings()
      if (!rows.length) {
        console.log('no open rulings')
        break
      }
      for (const row of rows) {
        console.log(
          `question ${row.question_id}  ${(row.task_key ?? '(untracked)').padEnd(12)} ` +
            `session ${row.session_id ?? 'unknown'}  since ${row.asked_at}  age ${human(row.age)}`,
        )
      }
      break
    }
    case 'task':
      await task(taskArguments)
      break
    case 'note':
      await note()
      break
    case 'report':
      await runReportCommand(argv)
      break
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE)
      break
    default:
      console.error(`hub: unknown command '${cmd}'\n`)
      console.log(USAGE)
      process.exit(1)
  }
} catch (e) {
  // The message alone: anything thrown here is meant for whoever typed the
  // command, and a non-zero exit is how a shell learns it did not work.
  console.error((e as Error).message)
  process.exit(1)
}

if (has('verbose')) console.error(`hub ${cmd} done at ${nowIso()}`)
