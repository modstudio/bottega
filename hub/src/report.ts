import { db, nowIso, type Project } from './db.ts'
import { tasksInWindow, completedInWindow, reportEngagedMs } from './query.ts'
import { human } from '../../shared/interval.ts'
import { getReport, smtpPassword, type Report, type Brief } from './settings.ts'
import { projectColor } from './projects.ts'
import { summarize } from './orch.ts'

export type Item = {
  key: string | null
  project: Project | string
  title: string | null
  status: string | null
  closed: boolean
  engaged: string
  engagedMs: number
  claudeTokens: number
  /** One business-readable sentence, written by the summariser. */
  sentence?: string
}

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

export function gather(r: Report, hours = r.windowHours) {
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
      claudeTokens: t.claudeTokens,
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
        claudeTokens: mine.reduce((s, i) => s + i.claudeTokens, 0),
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

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/**
 * The email.
 *
 * Inline styles only, and tables for layout: an email client will not load a
 * stylesheet and cannot be trusted with flex or grid. Every colour is a literal
 * hex for the same reason - a CSS variable resolves to nothing in Outlook.
 *
 * Structure follows the question a reader actually has: how much happened, then
 * where, then what. So a KPI row, then a per-project line, then the work grouped
 * under its project - rather than one flat list sorted by a number nobody asked
 * about.
 */
const INK = '#0f0f0e'
/**
 * The summary sits between the title and the metadata, and had to earn a gap
 * from both.
 *
 * Measured rather than eyeballed: title-against-summary was 2.45:1, which reads
 * as one block of text at a glance. #726f68 lifts that to 3.83:1 while staying
 * at 5.01:1 against white - above the 4.5:1 floor for body text. One shade
 * lighter separates better still and falls to 4.30:1, which is a summary nobody
 * with tired eyes can read, so it stops here.
 *
 * The TONE carries the hierarchy, which is why the title only needs 600. It was
 * briefly 700, chosen while the `font:` shorthand was silently dropping the
 * weight in mail clients - so it was tuned against a browser rendering nobody
 * receiving this email would ever see. Once the weight actually applied, 700
 * read as shouting.
 */
const MUTED = '#726f68'
const FAINT = '#96938b'
const RULE = '#e6e4de'
/**
 * Longhand, never the `font:` shorthand.
 *
 * Outlook and several mobile clients drop a `font:` shorthand whose family list
 * contains spaces and commas, and the whole declaration goes with it - weight
 * included. That is how a 700-weight title arrived on iOS at the same weight as
 * its own summary, undoing the contrast work entirely while looking correct in
 * every browser.
 *
 * Quoted family names for the same reason: an unquoted `Segoe UI` inside a
 * shorthand is what breaks the parse in the first place.
 */
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

/** Fall back to a system sans everywhere, since no webfont will load. */

const hours1 = (ms: number) => (ms / 3600_000).toFixed(1)

export function renderHtml(g: ReturnType<typeof gather>, sentences: Map<string, string>) {
  const day = new Date(g.to).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  })
  const tasks = g.items.filter((i) => i.key)
  const shipped = tasks.filter((i) => i.closed).length
  const moving = tasks.length - shipped

  const kpi = (value: string, label: string) => `
    <td class="kpi" style="padding:0 16px 0 0;vertical-align:top">
      <div class="kpin" style="font-family:${SANS};font-weight:600;font-size:30px;line-height:1.05;color:${INK};letter-spacing:-.02em">${esc(value)}</div>
      <div style="font-family:${SANS};font-weight:600;font-size:10px;line-height:1.4;letter-spacing:.1em;text-transform:uppercase;
                  color:${FAINT};padding-top:5px">${esc(label)}</div>
    </td>`

  // A TOTAL row, first, because the per-project hours do not add to it and a
  // reader is entitled to see the real figure in the same table rather than
  // inferring it from the KPI above. The counts DO add; only the hours do not,
  // and the footnote says why.
  // A header row and bare numbers, rather than repeating "shipped" and "open"
  // on every line. Five columns each carrying a word is what crowded this off
  // the side of a phone; the words belong at the top, once.
  const th = (text: string, align = 'right') => `
    <td class="th ${align === 'right' ? 'num' : ''}" style="padding:0 0 4px${align === 'right' ? ' 14px' : ''};text-align:${align};
               font-family:${SANS};font-weight:600;font-size:9.5px;line-height:1.4;
               letter-spacing:.09em;text-transform:uppercase;color:${FAINT};
               white-space:nowrap">${esc(text)}</td>`

  const headRow = `<tr>${th('', 'left')}${th('task')}${th('engaged')}${th('shipped')}${th('open')}</tr>`

  const totalRow = `
    <tr>
      <td style="padding:7px 0 8px">
        <span style="font-family:${SANS};font-weight:600;font-size:10px;line-height:1.4;letter-spacing:.1em;text-transform:uppercase;
                     color:${INK}">total</span>
      </td>
      <td style="padding:7px 0 8px;text-align:right;font-family:${SANS};font-weight:600;font-size:13px;line-height:1.4;
                 color:${INK};white-space:nowrap">${hours1(g.taskMs)}h</td>
      <td class="num" style="padding:7px 0 8px 14px;text-align:right;font-family:${SANS};font-weight:600;font-size:13px;line-height:1.4;
                 color:${INK};white-space:nowrap">${hours1(g.engagedMs)}h</td>
      <td class="num" style="padding:7px 0 8px 14px;text-align:right;font-family:${SANS};font-weight:600;font-size:13px;line-height:1.4;
                 color:${INK};white-space:nowrap">${shipped}</td>
      <td class="num" style="padding:7px 0 8px 14px;text-align:right;font-family:${SANS};font-weight:600;font-size:13px;line-height:1.4;
                 color:${MUTED};white-space:nowrap">${moving}</td>
    </tr>`

  const perProject = g.projects
    .map(
      (p) => `
    <tr>
      <td style="padding:7px 0;border-top:1px solid ${RULE}">
        <span style="display:inline-block;width:3px;height:11px;background:${projectColor(p.project) ?? MUTED};
                     vertical-align:-1px"></span>
        <span style="font-family:${SANS};font-weight:600;font-size:13px;line-height:1.4;color:${INK};padding-left:8px">${esc(p.project)}</span>
      </td>
      <td style="padding:7px 0;border-top:1px solid ${RULE};text-align:right;
                 font-family:${SANS};font-weight:400;font-size:13px;line-height:1.4;color:${MUTED};white-space:nowrap">
        ${hours1(p.taskMs)}h</td>
      <td class="num" style="padding:7px 0 7px 14px;border-top:1px solid ${RULE};text-align:right;
                 font-family:${SANS};font-weight:400;font-size:13px;line-height:1.4;color:${MUTED};white-space:nowrap">
        ${hours1(p.engagedMs)}h</td>
      <td class="num" style="padding:7px 0 7px 14px;border-top:1px solid ${RULE};text-align:right;
                 font-family:${SANS};font-weight:400;font-size:13px;line-height:1.4;color:${MUTED};white-space:nowrap">
        ${p.shipped}</td>
      <td class="num" style="padding:7px 0 7px 14px;border-top:1px solid ${RULE};text-align:right;
                 font-family:${SANS};font-weight:400;font-size:13px;line-height:1.4;color:${FAINT};white-space:nowrap">
        ${p.moving}</td>
    </tr>`,
    )
    .join('')

  const task = (i: Item) => {
    const s = sentences.get(i.key!)
    return `
    <tr><td style="padding:11px 0;border-top:1px solid ${RULE}">
      <div class="ttl" style="font-family:${SANS};font-weight:600;font-size:16px;line-height:1.35;color:${INK};letter-spacing:-.005em">${esc(i.title || i.key || '')}</div>
      ${s ? `<div style="font-family:${SANS};font-weight:400;font-size:14px;line-height:1.6;color:${MUTED};padding-top:5px">${esc(s)}</div>` : ''}
      <div style="font-family:${SANS};font-weight:400;font-size:12px;line-height:1.4;color:${FAINT};padding-top:5px">
        ${esc(i.key ?? '')} &middot; ${esc(i.engaged)} engaged
        ${i.closed ? `&middot; <span style="color:#15703C">shipped</span>` : ''}</div>
    </td></tr>`
  }

  const untasked = (i: Item) => `
    <tr><td style="padding:11px 0;border-top:1px solid ${RULE}">
      <div class="ttl" style="font-family:${SANS};font-weight:600;font-size:16px;line-height:1.35;color:${INK};letter-spacing:-.005em">No ticket</div>
      <div style="font-family:${SANS};font-weight:400;font-size:12px;line-height:1.4;color:${FAINT};padding-top:5px">
        ${esc(i.engaged)} not tied to a ticket</div>
    </td></tr>`

  const group = (p: (typeof g.projects)[number]) => {
    const done = p.items.filter((i) => i.closed)
    const open = p.items.filter((i) => !i.closed)
    return `
    <tr><td style="padding:26px 0 2px">
      <span style="display:inline-block;width:4px;height:14px;background:${projectColor(p.project) ?? MUTED};
                   vertical-align:-2px"></span>
      <span style="font-family:${SANS};font-weight:600;font-size:15px;line-height:1.4;color:${INK};padding-left:9px">${esc(p.project)}</span>
      <span class="gstat" style="font-family:${SANS};font-weight:400;font-size:12px;line-height:1.5;color:${FAINT};padding-left:9px">
        ${hours1(p.taskMs)}h of task work in ${hours1(p.engagedMs)}h
        &middot; ${p.shipped} shipped &middot; ${p.moving} open</span>
    </td></tr>
    <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${[...done, ...open].map(task).join('')}
      ${p.untasked ? untasked(p.untasked) : ''}
    </table></td></tr>`
  }

  // The charset is declared HERE as well as in the MIME header. A title with an
  // em dash in it renders as mojibake in any client that does not honour the
  // part header - which is how "Product matching & resolution overhaul - epic"
  // reached a preview as "overhaul a EUR" nonsense. Two declarations cost
  // nothing; one missing declaration corrupts a reader's copy.
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="format-detection" content="telephone=no">
  <style>
    /* Media queries ARE honoured by the clients that matter on a phone - iOS
       Mail, Outlook iOS and the Gmail app all render this head block. They are
       an enhancement, not the layout: every rule below narrows something that
       is already usable without it, so a client that strips the block still
       gets a readable email. That is the only safe way to use CSS in mail. */
    @media only screen and (max-width:480px) {
      .card { padding:20px 14px 24px !important }
      .kpi  { padding:0 12px 10px 0 !important }
      .kpin { font-size:23px !important }
      .num  { padding-left:9px !important; font-size:12px !important }
      .lead { font-size:12px !important }
      /* The project heading is a sentence, not a row: at this width it has to
         be allowed to wrap under its own name rather than mid-phrase. */
      .gstat { display:block !important; padding-left:0 !important; padding-top:2px !important }
      .ttl  { font-size:15px !important }
    }
    /* Narrower still - the 320px phones. The table's minimum width is set by
       its COLUMN HEADERS, not its numbers: "ENGAGED" and "SHIPPED" at 9.5px
       with letter-spacing were holding the card at 334px inside a 320px
       screen. Dropping the tracking and a half-point of size is enough; the
       numbers were never the problem. */
    @media only screen and (max-width:380px) {
      .card { padding:18px 10px 22px !important }
      .th   { font-size:9px !important; letter-spacing:0 !important }
      .num  { padding-left:7px !important }
      .kpi  { padding:0 9px 10px 0 !important }
      .kpin { font-size:21px !important }
    }
  </style></head>
  <body style="margin:0;padding:0;background:#f5f5f3;-webkit-text-size-adjust:100%">
  <div style="padding:16px 8px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center">
  <table role="presentation" class="card" cellpadding="0" cellspacing="0" border="0" width="100%"
         style="max-width:640px;background:#ffffff;padding:26px 22px 30px">

    <tr><td style="font-family:${SANS};font-weight:600;font-size:19px;line-height:1.3;color:${INK}">${esc(day)}</td></tr>
    <tr><td style="font-family:${SANS};font-weight:400;font-size:13px;line-height:1.5;color:${FAINT};padding-top:3px">
      the last ${g.hours} hours across ${g.projects.length}
      project${g.projects.length === 1 ? '' : 's'}</td></tr>

    <tr><td style="padding:20px 0 4px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>${kpi(hours1(g.taskMs) + 'h', 'task hours')}${kpi(hours1(g.engagedMs) + 'h', 'engaged')}${kpi(String(shipped), 'shipped')}${kpi(String(moving), 'open')}</tr>
      </table>
    </td></tr>

    <tr><td style="padding:18px 0 0">
      <div style="font-family:${SANS};font-weight:600;font-size:10px;line-height:1.4;letter-spacing:.1em;text-transform:uppercase;
                  color:${FAINT};padding-bottom:2px">by project</div>
      <div class="lead" style="font-family:${SANS};font-weight:400;font-size:11px;line-height:1.5;color:${FAINT};padding-bottom:4px">
        task hours add up; engaged is the wall clock of all reported work,
        including work carrying no ticket</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${headRow}${totalRow}${perProject}
      </table>
    </td></tr>

    ${g.projects.map(group).join('')}

    <tr><td style="padding:26px 0 0;border-top:1px solid ${RULE}">
      <div style="font-family:${SANS};font-weight:400;font-size:11px;line-height:1.6;color:${FAINT}">
        TASK HOURS adds the time charged to the tasks listed here. ENGAGED is one
        wall-clock union of those tasks and each project's work carrying no ticket,
        counting simultaneous work once. Untasked work appears only in ENGAGED, while
        parallel task hours overlap there.</div>
    </td></tr>
  </table>
  </td></tr></table></div></body></html>`
}

export function renderText(g: ReturnType<typeof gather>, sentences: Map<string, string>) {
  // The plain part mirrors the HTML's shape, because a reader who gets this one
  // should not get a different report.
  const line = (i: Item) =>
    [
      `  ${i.closed ? '+' : ' '} ${i.title || i.key}`,
      ...(sentences.get(i.key!) ? [`      ${sentences.get(i.key!)}`] : []),
      `      ${i.key} · ${i.engaged} engaged`,
    ].join('\n')
  const tasks = g.items.filter((i) => i.key)
  const shipped = tasks.filter((i) => i.closed).length
  return [
    `${hours1(g.taskMs)}h of task work in ${hours1(g.engagedMs)}h engaged · ` +
      `${shipped} shipped · ${tasks.length - shipped} in progress`,
    `the last ${g.hours} hours across ${g.projects.length} projects`,
    '',
    'BY PROJECT   (task hours add up; engaged includes work carrying no ticket)',
    `  ${'PROJECT'.padEnd(11)} ${'TASK'.padStart(6)} ${'ENGAGED'.padStart(8)}`,
    `  ${'TOTAL'.padEnd(11)} ${(hours1(g.taskMs) + 'h').padStart(6)}` +
      ` ${(hours1(g.engagedMs) + 'h').padStart(8)}` +
      `  ${String(shipped).padStart(2)} shipped  ${String(tasks.length - shipped).padStart(2)} open`,
    ...g.projects.map(
      (p) =>
        `  ${p.project.padEnd(11)} ${(hours1(p.taskMs) + 'h').padStart(6)}` +
        ` ${(hours1(p.engagedMs) + 'h').padStart(8)}` +
        `  ${String(p.shipped).padStart(2)} shipped  ${String(p.moving).padStart(2)} open`,
    ),
    ...g.projects.flatMap((p) => [
      '',
      p.project.toUpperCase(),
      ...[...p.items.filter((i) => i.closed), ...p.items.filter((i) => !i.closed)].map(line),
      ...(p.untasked ? [`  NO TICKET\n      ${p.untasked.engaged} not tied to a ticket`] : []),
    ]),
  ].join('\n')
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

export function recordSend(
  g: ReturnType<typeof gather>,
  r: Report,
  status: 'sent' | 'skipped' | 'failed',
  error?: string,
  opts: { test?: boolean; to?: string[] } = {},
) {
  db()
    .query(
      `INSERT INTO send (at, window, recipients, projects, items, status, error, test)
     VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      nowIso(),
      `${g.hours}h`,
      (opts.to ?? r.to).join(', '),
      r.projects.join(', '),
      g.items.length,
      status,
      error ?? null,
      opts.test ? 1 : 0,
    )
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

export { getReport }
