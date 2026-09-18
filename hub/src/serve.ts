import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { engagedMs, human, human as humanMs } from '../../shared/interval.ts'
import type { OrchBlockers } from '../../shared/orch-contract.ts'
import { appStaticPath, resolveAppStatic } from './app-static.ts'
import { attributeRun } from './attribute.ts'
import { collectFast, collectSlow, leaseHolder, watch, withLease } from './collect.ts'
import { db, enableSchemaReload, nowIso } from './db.ts'
import { promptLens } from './excerpt.ts'
import { chainVendorTokens, executionSpans } from './ingest/runs.ts'
import { state as orchState, blockers as readBlockers, readRuns } from './orch.ts'
import { routingViewData } from './orch-transforms.ts'
import { projectNames, projects, type RegisteredProject, trackerPresentation } from './projects.ts'
import {
  boardTasks,
  completedInWindow,
  intervalsInWindow,
  ratioSummary,
  spendGrid,
  stripWindow,
  tasksInWindow,
} from './query.ts'
import {
  gather,
  lastSends,
  recordOutcomeAfterEmail,
  renderHtml,
  renderText,
  send as sendMail,
  summarise,
} from './report.ts'
import { refreshHostedReportSetting } from './report-cache.ts'
import {
  appliedRunOffset,
  liveRowDisplay,
  matchesRunSearch,
  type RunPageLimit,
  runPageLimit,
  runRowDisplay,
  type SearchableLiveRun,
} from './run-display.ts'
import { getReport, secretStatus } from './settings.ts'
import { projectFlightDone } from './task-projections.ts'
import { hoursAgo } from './time.ts'
import { createContext } from './trpc/context.ts'
import { appRouter } from './trpc/router.ts'

const ORCH_CACHE_TTL_MS = 30_000

type CacheEntry<T> = { checkedAt: number; hasValue: boolean; value?: T; pending?: Promise<T> }

/** One load per key and TTL, including when several clients arrive together. */
export class TtlCache {
  private entries = new Map<string, CacheEntry<unknown>>()
  /** Bumped by clear(), so a load that started before a write cannot store its result after it. */
  private generation = 0
  private readonly ttlMs: number
  private readonly clock: () => number

  constructor(ttlMs: number, clock: () => number = Date.now) {
    this.ttlMs = ttlMs
    this.clock = clock
  }

  /**
   * The cached value while it is fresh. Once it expires the caller still gets
   * the last value at once and one background load replaces it, so a poll that
   * lands just after expiry never waits for a slow orch read. A key with no
   * value waits for its load, and a failed load drops the key so the next call
   * waits and sees the failure rather than a value that has stopped updating.
   */
  get<T>(key: string, load: () => Promise<T> | T): Promise<T> {
    const now = this.clock()
    const cached = this.entries.get(key) as CacheEntry<T> | undefined
    const fresh = cached !== undefined && now - cached.checkedAt < this.ttlMs
    if (cached?.hasValue && (fresh || cached.pending)) return Promise.resolve(cached.value as T)
    if (cached?.pending) return cached.pending
    const generation = this.generation
    const pending = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          if (generation === this.generation) {
            this.entries.set(key, { checkedAt: this.clock(), hasValue: true, value })
          }
          return value
        },
        (cause) => {
          if (generation === this.generation) this.entries.delete(key)
          throw cause
        },
      )
    if (cached?.hasValue) {
      this.entries.set(key, { ...cached, pending })
      pending.catch(() => undefined)
      return Promise.resolve(cached.value as T)
    }
    this.entries.set(key, { checkedAt: now, hasValue: false, pending })
    return pending
  }

  clear(): void {
    this.generation += 1
    this.entries.clear()
  }
}

const orchCache = new TtlCache(ORCH_CACHE_TTL_MS)

/** Cache a complete orch-backed procedure response, including its strip. */
export function cachedOrchResponse<T>(key: string, load: () => Promise<T> | T): Promise<T> {
  return orchCache.get(key, load)
}

/** Test isolation for suites that replace the orch client or its backing rows. */
export function clearOrchCache(): void {
  orchCache.clear()
}

/** The shared hub.db strip on an orch procedure follows the orch clock too. */
export function cachedStrip(hours: number) {
  return orchCache.get(`strip:${hours}`, () => strip(hours))
}

const blockerCache = new Map<
  number,
  {
    checkedAt: number
    value?: OrchBlockers
    pending?: Promise<OrchBlockers | null>
  }
>()

/**
 * Recurring environment problems, through the orchestrator's published CLI.
 *
 * The dashboard redraws every two seconds, while a blocker changes only when a
 * run finishes. Cache by window so changing the band never briefly shows the
 * old band's answer, and keep the last good value when the CLI is unavailable:
 * this panel must not take the rest of routing down with it.
 */
async function orchBlockers(days: number): Promise<OrchBlockers | null> {
  const now = Date.now()
  const cached = blockerCache.get(days)
  if (cached && now - cached.checkedAt < ORCH_CACHE_TTL_MS) {
    return cached.pending ?? cached.value ?? null
  }
  if (cached?.pending) return cached.pending

  const pending = (async () => {
    try {
      const value = await readBlockers(days)
      blockerCache.set(days, { checkedAt: Date.now(), value })
      return value
    } catch {
      blockerCache.set(days, { checkedAt: Date.now(), value: cached?.value })
      return cached?.value ?? null
    }
  })()

  blockerCache.set(days, { checkedAt: now, value: cached?.value, pending })
  return pending
}

/** The leaves of the left nav, and the only view names the API will serve. */
const VIEWS = ['flight', 'board', 'done', 'ratio', 'spend', 'routing', 'runs', 'settings'] as const
export type View = (typeof VIEWS)[number]

/** Single-quote a value so the command can be pasted into a shell as-is. */
function shSingle(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function settingsCmd(name: string, patch: Record<string, unknown>): string {
  return `orch project set ${shSingle(name)} --settings ${shSingle(JSON.stringify(patch))}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** The register, shaped for the settings screen. */
function presentRegister(rows: RegisteredProject[]) {
  return rows.map((p) => {
    const wt = asRecord(p.settings.worktree)
    const create = typeof wt?.create === 'string' && wt.create ? wt.create : null
    const recipe = asRecord(wt?.recipe)
    const worktree = create ? 'create' : recipe ? 'recipe' : 'neither'
    const notes = typeof wt?.notes === 'string' && wt.notes.trim() ? wt.notes : null
    const tracker = p.settings.tracker
    const trackerStatus = trackerPresentation(p)
    return {
      name: p.name,
      path: p.path,
      stack: p.stack,
      canon: p.canon,
      prefixes: p.settings.keyPrefixes ?? [],
      color: p.settings.color ?? null,
      colorDark: p.settings.colorDark ?? null,
      tracker:
        trackerStatus.state === 'unusable'
          ? `${trackerStatus.label} — unusable: ${trackerStatus.error}`
          : trackerStatus.label,
      trackerState: trackerStatus.state,
      trackerError: trackerStatus.error,
      worktree,
      notes,
      commands: {
        path: `orch project set ${shSingle(p.name)} --path ${shSingle(p.path)}`,
        stack: `orch project set ${shSingle(p.name)} --stack ${shSingle(p.stack ?? '')}`,
        canon: `orch project set ${shSingle(p.name)} ${p.canon ? '--canon' : '--no-canon'}`,
        prefixes: settingsCmd(p.name, { keyPrefixes: p.settings.keyPrefixes ?? [] }),
        color: settingsCmd(p.name, { color: p.settings.color ?? '' }),
        colorDark: settingsCmd(p.name, { colorDark: p.settings.colorDark ?? '' }),
        tracker: settingsCmd(p.name, { tracker: tracker ?? {} }),
        worktree: settingsCmd(p.name, {
          worktree: create ? { create } : recipe ? { recipe } : { recipe: {} },
        }),
        notes: notes == null ? null : settingsCmd(p.name, { worktree: { notes } }),
      },
    }
  })
}

function setting(key: string): string | null {
  const row = db()
    .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key = ?`)
    .get(key)
  if (!row) return null
  try {
    return JSON.parse(row.value) as string
  } catch {
    return row.value
  }
}

/**
 * The strip above the nav.
 *
 * It carries the facts you would otherwise change view to check — is anything
 * running, is anything broken — so it is on every view rather than being a
 * destination of its own.
 */
export function strip(hours: number) {
  const from = hoursAgo(hours)
  const to = nowIso()
  const window = stripWindow(from, to)
  const rows = window.tasks
  const active = new Set(rows.flatMap((r) => r.activeAgents))
  const r = ratioSummary(14, false)
  return {
    window: `${hours}h`,
    collectedAt: setting('collect.at'),
    // What CODE is answering, not just how fresh its data is.
    //
    // `hub serve` reads its TypeScript once at import, so a running server goes
    // on serving the bundle it started with however many times the source is
    // edited. The page looked perfectly current the whole time - a recent
    // collect time, live counters - while serving a version that predated the
    // work, and "I don't see the new thing" was indistinguishable from a bug in
    // the new thing. This is the one fact that separates them.
    servingSince: STARTED_AT,
    collector: leaseHolder(),
    engaged: human(window.engagedMs),
    activeAgents: [...active],
    tasksShipped: r.tasks,
    counts: {
      // Tasks only. The untracked rows have their own table and counting them
      // here would make the badge disagree with the heading beside it.
      flight: rows.filter(
        (x) => x.key && (x.workingNow || ['active', 'review'].includes(x.statusCategory ?? '')),
      ).length,
      done: rows.filter((x) => x.key && x.statusCategory === 'done').length,
      // Unscored delegated runs are a real chore queue, so the nav carries the
      // number rather than making you go and look.
      runs: window.orchRuns,
    },
  }
}

type RunFilters = {
  agent: string
  project: string
  source?: string
  offset?: number
  limit?: RunPageLimit
  search?: string
}

/** The UI calls local ownership "hub"; external source values are project names. */
function matchesSource(row: { source: string | null; project: string | null }, source?: string) {
  return (
    !source ||
    (source === 'hub' ? row.source === 'local' : row.source !== 'local' && row.project === source)
  )
}

function sourceFacets(rows: { source: string | null; project: string | null }[]) {
  return [
    ...new Set([
      'hub',
      ...projects()
        .filter((project) => project.settings.tracker)
        .map((project) => project.name),
      ...rows
        .filter((row) => row.source !== 'local')
        .map((row) => row.project)
        .filter((value): value is string => !!value),
    ]),
  ].sort()
}

export async function view(
  name: View,
  hours: number,
  f: RunFilters = { agent: '', project: '', source: '' },
) {
  const from = hoursAgo(hours)
  const to = nowIso()

  if (name === 'flight' || name === 'done') {
    return projectFlightDone({
      name,
      tasks: tasksInWindow(from, to),
      completed: completedInWindow(from, to),
      intervals: intervalsInWindow(from, to),
      filters: { agent: f.agent, project: f.project, source: f.source ?? '' },
      projects: projects(),
      now: Date.now(),
    })
  }

  if (name === 'ratio') {
    const s = ratioSummary(14)
    return {
      perTask: s.perTask,
      tokens: s.tokens,
      tasks: s.tasks,
      usableDays: s.usableDays,
      direction: s.direction,
      changePct: s.changePct,
      days: s.days.map((d) => ({
        day: d.day,
        ratio: d.ratio,
        tokens: d.claude_tokens,
        tasks: d.tasks,
        excluded: d.excluded,
      })),
    }
  }

  if (name === 'spend') return spendGrid(14)

  if (name === 'board') {
    /**
     * Every project's work in play, on one board.
     *
     * The estate's work does not sort itself by which system happens to hold
     * it, so a task this tool issued and one synced from a project's own
     * tracker sit side by side — distinguished, never blended, because a reader
     * has to know which they can act on here.
     */
    const b = boardTasks()
    const rows = b.cards.filter(
      (c) => (!f.project || c.project === f.project) && matchesSource(c, f.source),
    )
    /**
     * Facets from the REGISTER, not from the cards.
     *
     * Two reasons, and the second is the one that bit. A filter built from the
     * filtered rows could remove its own option and leave no way back — that
     * was already known. But building it from `b.cards` was barely better: those
     * are the cards that survived the CAP, so a project whose work all sorted
     * below the cut vanished from the picker entirely, and a registered project
     * with no open work at all — bottega, whose tasks are all done — was never
     * offered. A reader then cannot tell "this project has nothing open" from
     * "this is not a project", which are very different facts.
     *
     * So every registered project is always selectable, and picking a quiet one
     * shows an honest empty board. Projects appearing only in the data (a
     * renamed or retired one still carrying rows) are unioned in, so nothing on
     * the board is unreachable by its own filter.
     */
    const facets = {
      agents: [] as string[],
      projects: [
        ...new Set([
          ...projectNames(),
          ...Object.keys(b.totals.project).filter((p) => p !== 'elsewhere'),
        ]),
      ].sort() as string[],
      sources: sourceFacets(b.cards),
    }
    return {
      cards: rows,
      // TRUE totals, from the same filter the query used — never a count of
      // the page. A column header counting the rows it was handed understates
      // every column once the set outgrows one fetch.
      totals: b.totals,
      cap: b.cap,
      // What a project filter is hiding, so the totals above stay honest about
      // being estate-wide while the columns show one project.
      scoped: Boolean(f.project || f.source),
      filters: f,
      facets,
    }
  }

  if (name === 'routing') {
    // Rendered from the orchestrator's OWN payload rather than re-derived here.
    // Two places computing "how good is this agent at this job" is precisely
    // the drift the orchestrator already fixed once, when its stats command and
    // its dashboard read 96% while the router, counting failures, used 69%.
    const days = Math.max(1, Math.ceil(hours / 24))
    const [s, blockers] = await Promise.all([
      orchCache.get('state:all', () => orchState(null)),
      orchBlockers(days),
    ])
    return routingViewData(s, blockers, days)
  }

  if (name === 'runs') {
    const search = f.search ?? ''
    const limit = runPageLimit(f.limit)
    const requestedOffset = f.offset ?? 0
    const now = Date.now()
    // Orch read + attribution + shaping stay cached per hours/agent/project.
    // Search, display strings, and the page slice are per request and are not
    // part of that key.
    const built = await orchCache.get(`runs:${hours}:${f.agent}:${f.project}`, async () => {
      // Read through `orch runs --json`, not from hub's interval mirror: only the
      // orchestrator knows a run's VERDICT, and a runs list you cannot score from
      // is a list of chores you have to go elsewhere to do.
      // Windowed by the BAND, like every other view. This read a fixed 30 days
      // while the counters above it read the band, so the two disagreed the
      // moment any history fell outside it: at 24h the band said 256 runs over a
      // table listing 328. That is precisely what the note below forbids, and it
      // was invisible only because every run in this database is a day old.
      const raw = await orchCache.get(`runs-data:${hours}`, () => readRuns(hoursAgo(hours)))
      const shapedAt = Date.now()
      // The counters and the live table come from the orchestrator's own state,
      // over the SAME window as the run list beneath them - a band that counts a
      // different period than the table under it is worse than no band.
      const stateDays = Math.max(1, Math.round(hours / 24))
      const st = await orchCache.get(`state:${stateDays}`, () => orchState(stateDays))
      // Shaped BEFORE it is filtered, because `project` is not a column. It is
      // derived by attribute() from the run's cwd and prompt, so filtering the
      // raw row would be filtering on r.repo alone - and would then disagree
      // with the project this very table prints in the row beside it.
      const shaped = raw.map((r) => {
        const a = attributeRun(r)
        return {
          id: r.id,
          agent: r.agent,
          job: r.job,
          task: a.key,
          project: a.project ?? r.repo,
          at: r.started_at,
          engaged: human(engagedMs(executionSpans(r, shapedAt))),
          running: r.status === 'running',
          status: r.status,
          delivery: r.delivery ?? null,
          quality: r.quality ?? null,
          tokens: chainVendorTokens(r),
          costUsd: r.vendor_cost_usd,
          probe: !!r.probe,
          head: r.prompt_head,
          lens: promptLens(r.prompt_path),
          evidence_excluded: r.evidence_excluded ?? null,
        }
      })

      // The dropdowns offer what EXISTS, taken from the whole unfiltered window
      // rather than from the result. A filter that removes its own options from
      // the list is one you cannot climb back out of without a reload.
      const uniq = (xs: (string | null)[]) =>
        [...new Set(xs.filter((x): x is string => !!x))].sort()
      const facets = {
        agents: uniq(shaped.map((r) => r.agent)),
        projects: uniq(shaped.map((r) => r.project)),
      }

      // Filtered BEFORE the 120 cap, never after. Capped first, picking one project
      // would mean "that project's runs among the newest 120 runs" rather than "the
      // newest 120 runs for that project" - a filter that quietly searches a window
      // instead of the history, and reports a project as idle because a busier
      // one crowded it out.
      const keep = shaped.filter(
        (r) => (!f.agent || r.agent === f.agent) && (!f.project || r.project === f.project),
      )

      // Tokens stay per agent: vendors count them differently, so they are never summed.
      // Runs are one currency and are counted beside them.
      const vendorTotals = new Map<string, number>()
      const agentRuns = new Map<string, number>()
      for (const run of shaped) {
        agentRuns.set(run.agent, (agentRuns.get(run.agent) ?? 0) + 1)
        if (run.tokens == null) continue
        vendorTotals.set(run.agent, (vendorTotals.get(run.agent) ?? 0) + run.tokens)
      }
      const vendors = [...vendorTotals]
        .map(([agent, tokens]) => ({ agent, tokens, runs: agentRuns.get(agent) ?? 0 }))
        .sort((a, b) => b.tokens - a.tokens || a.agent.localeCompare(b.agent))

      return {
        totals: {
          runs: st.totals.runs,
          scored: st.totals.scored,
          voided: st.totals.voided ?? 0,
          failed: st.totals.failed,
          stale_n: st.totals.stale_n,
        },
        vendors,
        unscored: st.unscored,
        stale: st.stale,
        filters: { agent: f.agent, project: f.project },
        facets,
        keep,
        live: st.live.filter(
          (l) => (!f.agent || l.agent === f.agent) && (!f.project || (l.repo ?? '') === f.project),
        ),
      }
    })

    const rows = built.keep.map((row) => ({
      ...row,
      display: runRowDisplay(row, now),
    }))
    const matchedRows = rows.filter((row) => matchesRunSearch(row, search, now))
    const offset = appliedRunOffset(requestedOffset, matchedRows.length, limit)
    const live = built.live
      .map((l) => {
        const row: SearchableLiveRun = {
          id: l.id,
          agent: l.agent,
          job: l.job,
          repo: l.repo,
          elapsedMs: now - new Date(l.started_at).getTime(),
          prompt_head: l.prompt_head,
        }
        return { ...l, elapsedMs: row.elapsedMs, display: liveRowDisplay(row) }
      })
      .filter((mapped) =>
        matchesRunSearch(
          {
            id: mapped.id,
            agent: mapped.agent,
            job: mapped.job,
            repo: mapped.repo,
            elapsedMs: mapped.elapsedMs,
            prompt_head: mapped.prompt_head,
          },
          search,
          now,
        ),
      )

    return {
      totals: built.totals,
      vendors: built.vendors,
      unscored: built.unscored,
      stale: built.stale,
      filters: built.filters,
      facets: built.facets,
      matched: matchedRows.length,
      offset,
      limit,
      // Filtered on the same two axes, so the panel above the table cannot
      // contradict it. A live run carries only its `repo` - it has not been
      // through attribute() - which agrees with `project` for every repo this
      // machine has, and is the honest best available for a run still going.
      // Search applies here too; the live panel is not paged.
      live,
      // Uncapped, like a task's run list. The 120 was reaching back three and a
      // half hours on a table claiming 328 matches - a limit that decides how
      // far you can see, while the band is the control that is supposed to.
      // The band bounds this now, so a second hidden bound only fights it.
      rows: matchedRows.slice(offset, offset + limit),
    }
  }

  if (name === 'settings') {
    const r = getReport()
    const g = gather(r)
    return {
      report: r,
      allProjects: projectNames(),
      // Cached per process; not a shell-out on the two-second poll.
      register: presentRegister(projects()),
      // Only whether each secret RESOLVES, never its value.
      secrets: secretStatus(r),
      preview: { items: g.items.length, engaged: human(g.engagedMs), projects: g.projects },
      sends: lastSends(8),
    }
  }

  // A view whose data source is not connected yet says exactly what is missing
  // and what would fill it. A blank panel reads as breakage.
  return { pending: { needs: 'not built yet' } }
}

/** When this process loaded its code. Restarting is the only thing that moves it. */
const STARTED_AT = nowIso()

export async function sendTest() {
  const r = await refreshHostedReportSetting()
  const to = [r.testTo || r.fromAddress].filter(Boolean)
  if (!to.length) throw new Error('set a test address first')
  const g = gather(r)
  if (!g.items.length) throw new Error('nothing to report in this window')
  const sentences = await summarise(g.items, r.briefs)
  const shippedN = g.items.filter((i) => i.closed).length
  const subject =
    `[test] ${r.subjectPrefix}: ${shippedN} shipped, ` + `${humanMs(g.engagedMs)} engaged`
  const res = await sendMail(
    { ...r, to },
    subject,
    renderText(g, sentences),
    renderHtml(g, sentences),
  )
  await recordOutcomeAfterEmail(g, r, res, to, { test: true })
  if (!res.ok) throw new Error(res.error ?? 'send failed')
  return { ok: true as const, to, items: g.items.length }
}

export async function collectNow() {
  return withLease(
    `refresh:${process.pid}`,
    async () => {
      await collectSlow()
      await collectFast()
    },
    15_000,
  )
}

export function serve(port: number) {
  // Not started for an ephemeral port: server tests spin one up and down, and
  // should test responses rather than spend seconds collecting.
  //
  // The lease means this is safe beside the launchd daemon: whichever holds it
  // collects, the other waits, and neither has to know the other exists.
  if (port !== 0) watch(`serve:${process.pid}`)
  enableSchemaReload((from, to) => {
    console.log(`schema changed: reloading query layer (user_version ${from} -> ${to})`)
  })

  const server = Bun.serve({
    // A test send blocks on the summariser for a minute or so; Bun's default
    // 10s idle timeout dropped the response mid-send and the button showed an
    // error for an email that then arrived. 255s is Bun's ceiling.
    idleTimeout: 255,
    port,
    // Loopback only. This page carries a per-task record of everything this
    // machine works on across five private repos, and accepts an
    // unauthenticated POST that runs a collect.
    hostname: '127.0.0.1',
    async fetch(req) {
      db()
      const url = new URL(req.url)

      if (url.pathname.startsWith('/trpc')) {
        return fetchRequestHandler({
          endpoint: '/trpc',
          req,
          router: appRouter,
          createContext,
          // A write can change anything an orch read returned, so the next read starts fresh.
          responseMeta({ type }) {
            if (type === 'mutation') orchCache.clear()
            return {}
          },
        })
      }

      if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
        const target = url.pathname.slice('/app'.length) || '/'
        return Response.redirect(new URL(target + url.search, url), 301)
      }

      const dist = fileURLToPath(new URL('../web/dist', import.meta.url))
      const resolved = resolveAppStatic(url.pathname, existsSync(dist))
      if (resolved.kind === '503') {
        return new Response('hub/web is not built: cd hub/web && bun run build', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      }
      const file = Bun.file(appStaticPath(dist, resolved))
      if (!(await file.exists())) {
        // The index is checked too: streaming a missing file sends 200 headers
        // first and fails mid-body, which reads as a broken page, not an error.
        return resolved.kind === 'file'
          ? new Response('not found', { status: 404 })
          : new Response('hub/web is not built: cd hub/web && bun run build', {
              status: 503,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            })
      }
      return new Response(file)
    },
  })
  console.log(`hub serving on http://127.0.0.1:${server.port}`)
  return server
}
