#!/usr/bin/env bun
import { db, nextImportedTaskKey, nowIso } from './db.ts'
import { readFileSync } from 'node:fs'
import { ingestRuns } from './ingest/runs.ts'
import { ingestTranscripts } from './ingest/transcripts.ts'
import { ingestGit } from './ingest/git.ts'
import { ingestTrackers } from './ingest/trackers.ts'
import { tasksInWindow, estateEngagedMs, rollUpDays } from './query.ts'
import { watch, withLease } from './collect.ts'
import { closeTask, commentTask, createTask, listTasks, setTask, showTask } from './task.ts'
import { gather, summarise, renderHtml, renderText, send, recordSend } from './report.ts'
import { getReport } from './settings.ts'
import { human } from './interval.ts'
import { serve } from './serve.ts'
import { projectOf } from './attribute.ts'
import { projects } from './projects.ts'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name: string) => argv.includes(`--${name}`)

const USAGE = `hub — every project's tasks in flight, what each cost, and the daily report

  hub collect [--since ISO] [--only runs|transcripts|git|tasks]
                              ingest every source into hub.db
      --watch                 keep collecting on a clock; what launchd runs.
                              Safe beside a running dashboard: a lease in the
                              database means only one process collects.
  hub tasks [--hours N]       what has been worked on, newest window first
  hub serve [--port 7778]     the dashboard

  hub task new --project X --title "..." [--status Y] [--parent KEY] [--body "..."]
  hub task list [--project X] [--status Y] [--parent KEY] [--json]
  hub task show <KEY> [--json]
  hub task set <KEY> [--title "..."] [--status Y] [--parent KEY|--no-parent] [--body "..."]
  hub task close <KEY>
  hub task comment <KEY> "..."
  hub task import <file.json> backfill from a clustered commit history

  hub send [--dry-run]        the daily report; --dry-run prints it instead
      --test                  send the real thing, but only to the test address,
                              leaving the recipient list untouched
      --hours N               override the configured window

Engaged time is the UNION of every agent's working spans: a session waiting on a
delegated agent is not idle, and two agents running at once did not take twice
as long.
`

/** ISO for N hours ago. */
const hoursAgo = (n: number) => new Date(Date.now() - n * 3600_000).toISOString()

async function collect() {
  const since = flag('since') ?? hoursAgo(24 * 30)
  const only = flag('only')
  const run = (name: string) => !only || only === name
  const t0 = Date.now()

  if (run('git')) {
    const g = ingestGit(since.slice(0, 10))
    console.log(`git          ${g.days} days, ${g.tasks} task keys`)
  }
  if (run('runs')) {
    const r = await ingestRuns(since)
    console.log(`runs         ${r.rows} intervals, ${r.skipped} skipped`)
  }
  if (run('transcripts')) {
    const t = await ingestTranscripts(since)
    console.log(`transcripts  ${t.rows} intervals from ${t.files} files`)
  }

  if (run('tasks')) {
    for (const t of await ingestTrackers()) {
      const note = t.skipped ? `skipped: ${t.skipped}`
        : t.error ? `FAILED: ${t.error}`
        : `${t.tasks} tasks, ${t.changed} status changes`
      console.log(`${('tracker/' + t.project).padEnd(21)}${note}`)
    }
  }

  // The day grain is DERIVED from the intervals rather than collected on its
  // own. Two passes over the same transcripts would eventually disagree, and
  // the ratio would then depend on which one you read.
  console.log(`days         ${rollUpDays()} rolled up`)

  db().query(`INSERT INTO setting (key, value) VALUES ('collect.at', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(nowIso()))
  console.log(`\ncollected in ${human(Date.now() - t0)}`)
}

function tasks() {
  const hours = Number(flag('hours') ?? 48)
  const from = hoursAgo(hours)
  const to = nowIso()
  const rows = tasksInWindow(from, to)
  if (!rows.length) { console.log('nothing recorded in that window — run `hub collect` first'); return }

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

function task() {
  const sub = argv[1]
  const required = (name: string) => {
    const value = flag(name)
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} is required`)
    return value
  }
  const printRow = (row: ReturnType<typeof showTask>['task']) => {
    console.log(`${row.key.padEnd(10)} ${(row.status_category ?? '').padEnd(8)} ` +
                `${row.project.padEnd(12)} ${row.title ?? ''}`)
  }

  if (sub === 'new') {
    const row = createTask({ project: required('project'), title: required('title'),
      status: flag('status'), parent: flag('parent'), body: flag('body') })
    console.log(row.key)
    return
  }
  if (sub === 'list') {
    const rows = listTasks({ project: flag('project'), status: flag('status'), parent: flag('parent') })
    if (has('json')) console.log(JSON.stringify(rows))
    else if (!rows.length) console.log('no tasks')
    else rows.forEach(printRow)
    return
  }
  if (sub === 'show') {
    const shown = showTask(argv[2] ?? '')
    if (has('json')) console.log(JSON.stringify(shown))
    else {
      printRow(shown.task)
      if (shown.task.parent_key) console.log(`parent: ${shown.task.parent_key}`)
      if (shown.task.body) console.log(`\n${shown.task.body}`)
      for (const comment of shown.comments) console.log(`\n${comment.created_at}  ${comment.body}`)
    }
    return
  }
  if (sub === 'set') {
    if (has('parent') && has('no-parent')) throw new Error('--parent and --no-parent are mutually exclusive')
    const changes = {
      ...(has('title') ? { title: required('title') } : {}),
      ...(has('status') ? { status: required('status') } : {}),
      ...(has('parent') ? { parent: required('parent') } : has('no-parent') ? { parent: null } : {}),
      ...(has('body') ? { body: required('body') } : {}),
    }
    if (!Object.keys(changes).length) throw new Error('hub task set requires a field to change')
    printRow(setTask(argv[2] ?? '', changes))
    return
  }
  if (sub === 'close') { printRow(closeTask(argv[2] ?? '')); return }
  if (sub === 'comment') {
    const body = argv[3]
    if (!body) throw new Error('hub task comment <KEY> "..."')
    const comment = commentTask(argv[2] ?? '', body)
    console.log(`${comment.task_key} commented ${comment.created_at}`)
    return
  }
  if (sub === 'import') {
    const d = db()
    const at = nowIso()
    const project = projectOf(new URL('../..', import.meta.url).pathname)
    const registered = projects().find((candidate) => candidate.name === project)
    const prefix = registered?.settings.keyPrefixes?.[0]
    if (!project || !prefix) throw new Error('the local project must declare a key prefix')
    const file = argv[2]
    if (!file) throw new Error('hub task import <file.json>')
    const items = JSON.parse(readFileSync(file, 'utf8')) as {
      title: string; opened: string; closed: string | null; shas: string[]
    }[]
    // One pass over git for every commit's real instant, rather than a
    // subprocess per sha.
    const log = Bun.spawnSync(
      ['git', '-C', new URL('../..', import.meta.url).pathname, 'log', '--all', '--format=%H%x09%cI'],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    const stamps = new Map(
      new TextDecoder().decode(log.stdout).split('\n').filter(Boolean)
        .map((l) => l.split('\t') as [string, string]),
    )

    const ins = d.query(
      `INSERT INTO task (key, project, title, status, status_category, opened_at,
                         closed_at, updated_at, source, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)`,
    )
    const write = d.transaction(() => {
      for (const t of items) {
        const key = nextImportedTaskKey(prefix)
        const done = !!t.closed
        ins.run(key, project, t.title, done ? 'Done' : 'Open', done ? 'done' : 'open',
                t.opened, t.closed, t.closed ?? t.opened, at, at)
        // Backfilled tasks carry their commits, so commit-window attribution
        // can find them.
        //
        // With the REAL commit timestamp, not the task's date. Every other row
        // in this table holds a full ISO instant, and "2026-08-31" sorts BEFORE
        // "2026-08-31T14:00:00Z" — so a date-only row falls outside every window
        // that contains its own day, and matches nothing, silently.
        for (const sha of t.shas) {
          const at = stamps.get(sha)
          if (!at) continue
          d.query(`INSERT OR IGNORE INTO commit_key (sha, repo, task_key, at) VALUES (?,?,?,?)`)
            .run(sha, project, key, at)
        }
      }
    })
    write()
    console.log(`imported ${items.length} tasks`)
    return
  }
  throw new Error('hub task <new|list|show|set|close|comment|import>')
}

async function sendReport() {
  const r = getReport()
  const hours = Number(flag('hours') ?? r.windowHours)
  const g = gather(r, hours)
  const dry = has('dry-run')

  // A test is the REAL email to a different address. The recipient list is not
  // edited down and put back, because that is how a colleague quietly stops
  // receiving a report nobody notices has stopped.
  const test = has('test')
  const to = test ? [r.testTo || r.fromAddress].filter(Boolean) : r.to
  if (test && !to.length) {
    throw new Error('no test address: set testTo, or a from address, in settings')
  }

  if (!g.items.length) {
    console.log('nothing to report in that window')
    if (!dry) recordSend(g, r, 'skipped', 'no items', { test, to })
    return
  }
  // The guard counts ENGAGED time, not conversation time. work-report's counted
  // only Claude's own message gaps, so a day of heavy delegation - or of tracker
  // and commit work - could fall under the bar and skip silently.
  // The floor guards the DAILY report from going out on a quiet day. A test is
  // asked for deliberately, so it is not held back by it.
  const minutes = Math.round(g.engagedMs / 60_000)
  if (!dry && !test && minutes < r.minMinutes) {
    console.log(`only ${minutes}m engaged, under the ${r.minMinutes}m floor; not sending`)
    recordSend(g, r, 'skipped', `${minutes}m engaged`, { test, to })
    return
  }

  const sentences = await summarise(g.items, r.briefs)
  const text = renderText(g, sentences)
  const shipped = g.items.filter((i) => i.closed).length
  const subject = `${r.subjectPrefix}: ${shipped} shipped, ${human(g.engagedMs)} engaged`

  if (dry) {
    console.log(`to:      ${to.join(', ') || '(nobody configured)'}${test ? '   [test]' : ''}`)
    console.log(`subject: ${subject}`)
    console.log(`projects: ${r.projects.join(', ')}`)
    console.log(`summarised: ${sentences.size} of ${g.items.length}`)
    console.log('')
    console.log(text)
    return
  }
  // Disabled stops the DAILY send, not a test: turning the report off should
  // not also take away the way to check it before turning it back on.
  if (!r.enabled && !test) {
    console.log('report is disabled in settings')
    recordSend(g, r, 'skipped', 'disabled', { test, to })
    return
  }

  const res = await send({ ...r, to }, test ? `[test] ${subject}` : subject,
                         text, renderHtml(g, sentences))
  recordSend(g, r, res.ok ? 'sent' : 'failed', res.error, { test, to })
  console.log(res.ok ? `${test ? 'test ' : ''}sent to ${to.join(', ')}` : `FAILED: ${res.error}`)
  if (!res.ok) process.exit(1)
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

switch (cmd) {
  case 'collect':
    if (has('watch')) {
      console.log(`hub: collecting every ${20}s (fast) and ${300}s (slow); ctrl-c to stop`)
      watch(`collect:${process.pid}`, (e) => console.error(`hub: collect failed: ${e.message}`))
      // Hold the process open for launchd, which restarts anything that exits.
      await new Promise(() => {})
    }
    {
      // Through the lease, not around it. This used to call collect() directly,
      // which let it interleave with `hub serve` and the launchd daemon while
      // the transcripts leg was clearing and rewriting spans.
      const r = await withLease(`collect:${process.pid}`, collect)
      if (!r.ran) {
        console.error(`hub: ${r.heldBy ?? 'another process'} is collecting and did not `
          + 'finish in 30s; nothing collected')
        process.exit(1)
      }
    }
    break
  case 'tasks': tasks(); break
  case 'serve': serve(Number(flag('port') ?? 7778)); break
  case 'task': task(); break
  case 'send': await sendReport(); break
  case undefined:
  case 'help':
  case '--help':
    console.log(USAGE); break
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
