// concern: report-renderer

import { compactTokens } from '../../shared/compact-number.ts'
import type { Measures } from './measures.ts'

export type Item = {
  key: string | null
  projectId?: string | null
  spaceId?: string
  project: string
  title: string | null
  status: string | null
  closed: boolean
  engaged: string
  engagedMs: number
  agentTokens: number
  /** One business-readable sentence, written by the summarizer. */
  sentence?: string
}

export type GatheredReport = {
  from: string
  to: string
  hours: number
  items: Item[]
  taskMs: number
  engagedMs: number
  projects: {
    project: string
    color: string | null
    taskMs: number
    engagedMs: number
    shipped: number
    moving: number
    agentTokens: number
    items: Item[]
    untasked: Item | null
  }[]
}

export type ReportPresentation = {
  scopeName: string
  windowLine: string
  measures: Measures
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/**
 * The email.
 *
 * Inline styles only, and tables for layout: an email client will not load a
 * stylesheet and cannot be trusted with flex or grid. Every color is a literal
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

export function renderHtml(
  g: GatheredReport,
  sentences: Map<string, string>,
  presentation?: ReportPresentation,
  options: { details?: boolean } = {},
) {
  const day = new Date(g.to).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  })
  const tasks = g.items.filter((i) => i.key)
  const shipped = tasks.filter((i) => i.closed).length
  const moving = tasks.length - shipped
  const measureLines = presentation ? reportMeasureLines(presentation) : []

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
  // A header row and bare numbers, rather than repeating "done" and "open"
  // on every line. Five columns each carrying a word is what crowded this off
  // the side of a phone; the words belong at the top, once.
  const th = (text: string, align = 'right') => `
    <td class="th ${align === 'right' ? 'num' : ''}" style="padding:0 0 4px${align === 'right' ? ' 14px' : ''};text-align:${align};
               font-family:${SANS};font-weight:600;font-size:9.5px;line-height:1.4;
               letter-spacing:.09em;text-transform:uppercase;color:${FAINT};
               white-space:nowrap">${esc(text)}</td>`

  const headRow = `<tr>${th('', 'left')}${th('task')}${th('engaged')}${th('done')}${th('open')}</tr>`

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
        <span style="display:inline-block;width:3px;height:11px;background:${p.color ?? MUTED};
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
        &middot; ${esc(compactTokens(i.agentTokens))} agent tokens
        ${i.closed ? `&middot; <span style="color:#15703C">done</span>` : ''}</div>
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
      <span style="display:inline-block;width:4px;height:14px;background:${p.color ?? MUTED};
                   vertical-align:-2px"></span>
      <span style="font-family:${SANS};font-weight:600;font-size:15px;line-height:1.4;color:${INK};padding-left:9px">${esc(p.project)}</span>
      <span class="gstat" style="font-family:${SANS};font-weight:400;font-size:12px;line-height:1.5;color:${FAINT};padding-left:9px">
        ${hours1(p.taskMs)}h of task work in ${hours1(p.engagedMs)}h
        &middot; ${p.shipped} done &middot; ${p.moving} open</span>
    </td></tr>
    <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${[...done, ...open].map(task).join('')}
      ${p.untasked ? untasked(p.untasked) : ''}
    </table></td></tr>`
  }

  // The charset is declared HERE as well as in the MIME header. A title with an
  // em dash in it renders as mojibake in any client that does not honor the
  // part header - which is how "Product matching & resolution overhaul - epic"
  // reached a preview as "overhaul a EUR" nonsense. Two declarations cost
  // nothing; one missing declaration corrupts a reader's copy.
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="format-detection" content="telephone=no">
  <style>
    /* Media queries ARE honored by the clients that matter on a phone - iOS
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
       its COLUMN HEADERS, not its numbers: "ENGAGED" and "DONE" at 9.5px
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
    ${presentation ? `<tr><td style="font-family:${SANS};font-weight:400;font-size:12px;line-height:1.5;color:${MUTED};padding-top:5px">${esc(presentation.windowLine)}</td></tr>` : ''}

    <tr><td style="padding:20px 0 4px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>${kpi(hours1(g.taskMs) + 'h', 'task hours')}${kpi(hours1(g.engagedMs) + 'h', 'engaged')}${kpi(String(shipped), 'done')}${kpi(String(moving), 'open')}</tr>
      </table>
    </td></tr>

    ${measureLines.length ? `<tr><td style="padding:18px 0 0"><div style="font-family:${SANS};font-weight:600;font-size:10px;line-height:1.4;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};padding-bottom:4px">measures</div>${measureLines.map((line) => `<div style="font-family:${SANS};font-weight:400;font-size:13px;line-height:1.6;color:${MUTED}">${esc(line)}</div>`).join('')}</td></tr>` : ''}

    ${
      options.details === false
        ? ''
        : `<tr><td style="padding:18px 0 0">
      <div style="font-family:${SANS};font-weight:600;font-size:10px;line-height:1.4;letter-spacing:.1em;text-transform:uppercase;
                  color:${FAINT};padding-bottom:2px">by project</div>
      <div class="lead" style="font-family:${SANS};font-weight:400;font-size:11px;line-height:1.5;color:${FAINT};padding-bottom:4px">
        task hours add up; engaged is the wall clock of all reported work,
        including work carrying no ticket</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${headRow}${totalRow}${perProject}
      </table>
    </td></tr>`
    }

    ${options.details === false ? '' : g.projects.map(group).join('')}

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

const measureHours = (ms: number) => {
  const value = ms / 3_600_000
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${value === 1 ? 'hour' : 'hours'}`
}

const measureMoney = (value: number) => `$${value.toFixed(2)}`

function reportMeasureLines(presentation: ReportPresentation) {
  const { measures, scopeName } = presentation
  const lines: string[] = []
  if (measures.scope === 'person') {
    lines.push(
      `Recorded work for ${scopeName} was running for ${measureHours(measures.hoursRunning.unionMs)}.`,
      `${scopeName} started ${measureHours(measures.agentHours.sumMs).replace(' hour', ' agent-hour')}.`,
      `${scopeName} was in session for ${measureHours(measures.sessionTime.unionThenSumMs)}.`,
    )
  } else {
    lines.push(
      `Work was running for ${measureHours(measures.hoursRunning.unionMs)}. This measure is not additive.`,
      `Agents ran for ${measureHours(measures.agentHours.sumMs).replace(' hour', ' agent-hour')}.`,
      `People were in session for ${measureHours(measures.sessionTime.unionThenSumMs)}.`,
    )
  }
  lines.push(
    measures.sessionTime.silenceAllowanceSentence,
    `${measureHours(measures.sessionTime.uncountedSilenceMs)} of silence was uncounted.`,
  )
  if (measures.agentHours.unknownShare)
    lines.push(
      `${measureHours(measures.agentHours.unknownShare.sumMs).replace(' hour', ' agent-hour')} had unknown attribution.`,
    )
  if (measures.sessionTime.unknownUser)
    lines.push(
      `${measureHours(measures.sessionTime.unknownUser.unionThenSumMs)} of session time had unknown attribution.`,
    )
  lines.push(`Agent runs cost ${measureMoney(measures.cost.vendorCostUsd)}.`)
  if ('shipped' in measures) {
    lines.push(
      `${measures.shipped.count} ${measures.shipped.count === 1 ? 'task moved' : 'tasks moved'} to done in this window.`,
      measures.cycleTime
        ? `Median cycle time for tasks done was ${measureHours(measures.cycleTime.medianMs)} across ${measures.cycleTime.n} ${measures.cycleTime.n === 1 ? 'task' : 'tasks'}.`
        : 'No task moved to done had enough recorded activity to calculate cycle time.',
    )
  }
  return lines
}

export function renderText(
  g: GatheredReport,
  sentences: Map<string, string>,
  presentation?: ReportPresentation,
  options: { details?: boolean } = {},
) {
  // The plain part mirrors the HTML's shape, because a reader who gets this one
  // should not get a different report.
  const line = (i: Item) =>
    [
      `  ${i.closed ? '+' : ' '} ${i.title || i.key}`,
      ...(sentences.get(i.key!) ? [`      ${sentences.get(i.key!)}`] : []),
      `      ${i.key} · ${i.engaged} engaged · ${compactTokens(i.agentTokens)} agent tokens`,
    ].join('\n')
  const tasks = g.items.filter((i) => i.key)
  const shipped = tasks.filter((i) => i.closed).length
  return [
    `${hours1(g.taskMs)}h of task work in ${hours1(g.engagedMs)}h engaged · ` +
      `${shipped} done · ${tasks.length - shipped} in progress`,
    `the last ${g.hours} hours across ${g.projects.length} projects`,
    ...(presentation ? [presentation.windowLine, '', ...reportMeasureLines(presentation)] : []),
    ...(options.details === false
      ? []
      : [
          '',
          'BY PROJECT   (task hours add up; engaged includes work carrying no ticket)',
          `  ${'PROJECT'.padEnd(11)} ${'TASK'.padStart(6)} ${'ENGAGED'.padStart(8)}`,
          `  ${'TOTAL'.padEnd(11)} ${(hours1(g.taskMs) + 'h').padStart(6)}` +
            ` ${(hours1(g.engagedMs) + 'h').padStart(8)}` +
            `  ${String(shipped).padStart(2)} done  ${String(tasks.length - shipped).padStart(2)} open`,
          ...g.projects.map(
            (p) =>
              `  ${p.project.padEnd(11)} ${(hours1(p.taskMs) + 'h').padStart(6)}` +
              ` ${(hours1(p.engagedMs) + 'h').padStart(8)}` +
              `  ${String(p.shipped).padStart(2)} done  ${String(p.moving).padStart(2)} open`,
          ),
          ...g.projects.flatMap((p) => [
            '',
            p.project.toUpperCase(),
            ...[...p.items.filter((i) => i.closed), ...p.items.filter((i) => !i.closed)].map(line),
            ...(p.untasked
              ? [`  NO TICKET\n      ${p.untasked.engaged} not tied to a ticket`]
              : []),
          ]),
        ]),
  ].join('\n')
}
