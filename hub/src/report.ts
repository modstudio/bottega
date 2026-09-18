import { hostname } from 'node:os'
import { human } from '../../shared/interval.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import { summarize } from './orch.ts'
import { projectColor } from './projects.ts'
import { completedInWindow, reportEngagedMs, tasksInWindow } from './query.ts'
import { cacheHostedSend } from './report-cache.ts'
import { hostedAppendSend, type ReportClientOptions } from './report-client.ts'
import type { GatheredReport, Item } from './report-renderer.ts'
import { type Brief, type Report, smtpPassword } from './settings.ts'

export {
  type GatheredReport,
  type Item,
  renderHtml,
  renderText,
} from './report-renderer.ts'

/**
 * What happened, per task, over the window.
 *
 * This is where hub's model pays for itself: work-report had to reconstruct
 * "what was worked on" by clustering raw events on ticket keys and normalised
 * titles, 880 lines of it. Here the tasks already exist, already carry their
 * titles from the trackers, and already carry engaged time and spend. The
 * report is a projection, not a pipeline.
 */
/** Which brief, if any, claims a task. Key and title, case-insensitive. */
function briefFor(briefs: Brief[], key: string | null, title: string | null): Brief | null {
  const hay = `${key ?? ''} ${title ?? ''}`.toLowerCase()
  return briefs.find((b) => b.match.some((m) => hay.includes(m.toLowerCase()))) ?? null
}

export function gather(r: Report, hours = r.windowHours): GatheredReport {
  const from = new Date(Date.now() - hours * 3600_000).toISOString()
  const to = nowIso()
  const closed = new Set(completedInWindow(from, to).map((c) => c.key))
  const wanted = new Set<string>(r.projects)

  const items: Item[] = tasksInWindow(from, to)
    .filter((t) => t.project && wanted.has(t.project))
    // Excluded work is still measured everywhere else - it is in engaged time,
    // in the ratio, on the dashboard. It is only kept out of the email, which
    // is what "internal QA is not its own work output" means in practice.
    .filter((t) => !briefFor(r.briefs, t.key, t.title)?.exclude)
    .map((t) => ({
      key: t.key,
      project: t.project!,
      title: t.title,
      status: t.status,
      // CLOSED IN THIS WINDOW, not merely closed. Counting every task that is
      // currently done called 35 things "shipped today" when only a handful
      // had closed today; the rest were finished long ago and merely touched.
      //
      // Two sources, because neither is complete on its own: an observed
      // transition is the only thing hub saw for itself, but the status-event
      // history only starts when the tracker leg does. Some trackers supply
      // updated_at and some do not, so a non-null field fills that gap.
      closed: !!(
        t.key &&
        (closed.has(t.key) || (t.statusCategory === 'done' && t.updatedAt && t.updatedAt >= from))
      ),
      engaged: human(t.engagedMs),
      engagedMs: t.engagedMs,
      agentTokens: t.vendors.reduce((sum, vendor) => sum + vendor.tokens, 0),
    }))
    .sort((a, b) => b.engagedMs - a.engagedMs)

  // Per project, ordered by the time actually spent in it. Engaged time is
  // unioned WITHIN a project for the same reason it is unioned everywhere
  // else - two of its tasks worked in parallel occupied one stretch of clock.
  const projects = [...new Set(items.map((i) => i.project))]
    .map((project) => {
      const mine = items.filter((i) => i.project === project)
      const tasks = mine.filter((i) => i.key)
      const untasked = mine.find((i) => !i.key) ?? null
      return {
        project,
        color: projectColor(project),
        // Two different true numbers. taskMs ADDS UP the named tasks, while
        // engagedMs is one wall-clock union of those tasks and this project's
        // untasked bucket. Parallel spans occupy that union only once.
        taskMs: tasks.reduce((s, i) => s + i.engagedMs, 0),
        engagedMs: reportEngagedMs(
          tasks.map((i) => i.key!),
          untasked ? [project] : [],
          from,
          to,
        ),
        shipped: tasks.filter((i) => i.closed).length,
        moving: tasks.filter((i) => !i.closed).length,
        agentTokens: mine.reduce((s, i) => s + i.agentTokens, 0),
        items: tasks,
        untasked,
      }
    })
    .sort((a, b) => b.engagedMs - a.engagedMs)

  return {
    from,
    to,
    hours,
    items,
    taskMs: items.filter((i) => i.key).reduce((s, i) => s + i.engagedMs, 0),
    engagedMs: reportEngagedMs(
      items.flatMap((i) => (i.key ? [i.key] : [])),
      items.flatMap((i) => (i.key ? [] : [i.project])),
      from,
      to,
    ),
    projects,
  }
}

/**
 * One sentence per task, from one delegated call.
 *
 * Through `orch`, which costs neither metered spend nor the Claude allotment.
 * work-report defaulted to `claude_cli`, which spends exactly the allotment the
 * orchestrator exists to protect, and which was returning truncated JSON in the
 * logs. Its config already named `orch` as the preferred mode; this makes it
 * the only mode.
 */
export async function summarise(items: Item[], briefs: Brief[] = []): Promise<Map<string, string>> {
  const tasks = items.filter((i) => i.key)
  if (!tasks.length) return new Map()
  const lines = tasks.map((i) => {
    const b = briefFor(briefs, i.key, i.title)
    return (
      `${i.key}\t${i.project}\t${i.closed ? 'shipped' : 'in progress'}\t${i.engaged}\t` +
      `${i.title ?? ''}${b?.brief ? `\tCONTEXT: ${b.brief}` : ''}`
    )
  })
  const prompt = [
    'Below is a day of software work, one task per line:',
    '  KEY<TAB>PROJECT<TAB>STATE<TAB>ENGAGED<TAB>TITLE[<TAB>CONTEXT]',
    'Where CONTEXT is given it is stakes you could not infer from the title;',
    'honour it, and let it shape how much the sentence claims.',
    '',
    'For each, write ONE sentence a non-engineer stakeholder would understand:',
    'what changed and why it matters. 20-40 words. No jargon, no ticket numbers',
    'in the prose, no invented detail beyond the title and state given.',
    '',
    'Return ONLY a JSON object mapping key to sentence. No prose, no code fence.',
    '',
    ...lines,
  ].join('\n')

  // PINNED to codex, deliberately, against the router's own preference.
  //
  // Over eleven judged runs codex is 100% of 3 and qwen-local 50% of 9, and the
  // failure is not stylistic: qwen-local dropped tasks on three consecutive
  // sends, so real entries reached a real inbox with a title and no sentence.
  // The router will reach the same answer once codex crosses its five-judgement
  // threshold, and until then the threshold is right to hold - three runs is
  // thin evidence and a couple of good results should not lock in an agent.
  //
  // This is one call a day where completeness beats forty seconds, so it does
  // not wait. Every other summarize caller keeps the routed agent.
  //
  // --follow, because `orch do` DETACHES by default (29d43a0) and --quiet then
  // prints the run id, not the reply. For a day this call parsed a run id as
  // JSON, failed, and fell back to titles - and the fallback was silent, so
  // the email went out with no sentences and nothing said so. Now it waits for
  // the reply, and a fallback names itself on stderr and in the send log.
  let out: string
  try {
    out = await summarize(prompt)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error(`report: summarise failed; sending titles only\n${message.slice(-400)}`)
    return new Map()
  }
  try {
    const json = out
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim()
    const obj = JSON.parse(json) as Record<string, string>
    const got = new Map(Object.entries(obj))
    const missing = tasks.filter((i) => !got.get(i.key!)).map((i) => i.key)
    if (missing.length) console.error(`report: no sentence for ${missing.join(', ')}`)
    return got
  } catch {
    // A summariser that returns nothing usable must not lose the report. The
    // titles are already true; the sentences are the enrichment.
    console.error(
      `report: summarise reply was not JSON; sending titles only\n${out.trim().slice(0, 200)}`,
    )
    return new Map()
  }
}

/**
 * Send over SMTP with curl.
 *
 * Rather than a mailer dependency: this concern has no runtime dependencies at
 * all, and a daily email is not a good reason for its first. curl already
 * speaks smtp and smtps, and the password is passed on stdin via `--config` so
 * it never appears in the process list where `ps` would show it.
 */
export async function send(
  r: Report,
  subject: string,
  text: string,
  html: string,
): Promise<{ ok: boolean; error?: string }> {
  const pass = smtpPassword(r.smtpPasswordRef)
  if (!pass) return { ok: false, error: `no password at ${r.smtpPasswordRef}` }
  if (!r.to.length) return { ok: false, error: 'no recipients configured' }

  const boundary = `hub-${Date.now().toString(36)}`
  const message = [
    `From: ${r.fromName} <${r.fromAddress}>`,
    `To: ${r.to.join(', ')}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n')

  const args = [
    'curl',
    '--silent',
    '--show-error',
    '--url',
    `smtp://${r.smtpHost}:${r.smtpPort}`,
    '--ssl-reqd',
    '--mail-from',
    r.fromAddress,
    ...r.to.flatMap((t) => ['--mail-rcpt', t]),
    // Credentials come from a config file on stdin, never from argv.
    '--config',
    '-',
    '--upload-file',
    '-',
  ]
  // curl reads --config from stdin, then the upload from stdin too, which it
  // cannot do — so the message goes in a temp file and only the credential
  // rides stdin.
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/hub-mail-${boundary}.eml`
  await Bun.write(tmp, message)
  const idx = args.indexOf('--upload-file')
  args[idx + 1] = tmp

  const proc = Bun.spawn(args, {
    stdin: new TextEncoder().encode(`user = "${r.smtpUser}:${pass}"\n`),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  try {
    await Bun.file(tmp).delete()
  } catch {
    /* best effort */
  }
  return code === 0 ? { ok: true } : { ok: false, error: err.trim() || `curl exited ${code}` }
}

export async function recordSend(
  g: ReturnType<typeof gather>,
  r: Report,
  status: 'sent' | 'skipped' | 'failed',
  error?: string,
  opts: { test?: boolean; to?: string[]; client?: ReportClientOptions } = {},
) {
  const outcome = {
    at: nowIso(),
    window: `${g.hours}h`,
    recipients: (opts.to ?? r.to).join(', '),
    projects: r.projects.join(', '),
    items: g.items.length,
    status,
    error: error ?? null,
    test: opts.test ? 1 : 0,
    machine: hostname(),
  }
  const hosted = await hostedAppendSend(outcome, opts.client)
  writeTransaction((conn) => cacheHostedSend(conn, hosted))
  return hosted
}

function unrecordedSendOutcome(
  g: ReturnType<typeof gather>,
  status: 'sent' | 'failed',
  recipients: string[],
) {
  return JSON.stringify({
    time: nowIso(),
    status,
    recipients: recipients.length,
    items: g.items.length,
  })
}

export async function recordOutcomeAfterEmail(
  g: ReturnType<typeof gather>,
  r: Report,
  result: { ok: boolean; error?: string },
  to: string[],
  opts: { test?: boolean; client?: ReportClientOptions } = {},
) {
  const status = result.ok ? 'sent' : 'failed'
  try {
    return await recordSend(g, r, status, result.error, { ...opts, to })
  } catch (error) {
    console.error(`email outcome was not recorded: ${unrecordedSendOutcome(g, status, to)}`)
    throw error
  }
}

export const lastSends = (n = 10) =>
  db()
    .query<
      {
        at: string
        window: string
        recipients: string
        projects: string
        items: number
        status: string
        error: string | null
        test: number
      },
      [number]
    >(
      `SELECT at, window, recipients, projects, items, status, error, test
       FROM send ORDER BY id DESC LIMIT ?`,
    )
    .all(n)
