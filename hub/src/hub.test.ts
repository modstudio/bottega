import { expect, test, describe } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { union, engagedMs, spansFromTimestamps, human, DEFAULT_IDLE_CAP_MS } from './interval.ts'

// db.ts fixes its path at import time. Give this suite a disposable database
// before dynamically loading modules that reach it.
const testDir = mkdtempSync(join(tmpdir(), 'hub-test-'))
process.env.HUB_DB = join(testDir, 'hub.db')
const {
  attribute, keyFromWorktree, keyFromBranch, projectOf, projectOfKey, isInjected,
} = await import('./attribute.ts')
const { spendingSpans } = await import('./ingest/transcripts.ts')
const { db } = await import('./db.ts')
const { gather, renderHtml, renderText } = await import('./report.ts')
const { easternTime } = await import('./time.ts')
const { projectColor, projectNames } = await import('./projects.ts')
const { ingestTrackers, upsertTrackerTask, resolveAssigneeIds } =
  await import('./ingest/trackers.ts')
const { createTask, showTask } = await import('./task.ts')

process.on('exit', () => {
  try { rmSync(testDir, { recursive: true, force: true }) } catch {}
})

const at = (iso: string) => new Date(iso).getTime()

describe('interval union', () => {
  test('a span on its own is its own length', () => {
    expect(engagedMs([{ start: 0, end: 5000 }])).toBe(5000)
  })

  test('overlapping spans are counted once', () => {
    expect(engagedMs([{ start: 0, end: 10_000 }, { start: 5000, end: 15_000 }])).toBe(15_000)
  })

  test('a span wholly inside another adds nothing', () => {
    expect(engagedMs([{ start: 0, end: 10_000 }, { start: 2000, end: 3000 }])).toBe(10_000)
  })

  test('disjoint spans add', () => {
    expect(engagedMs([{ start: 0, end: 1000 }, { start: 5000, end: 6000 }])).toBe(2000)
  })

  test('touching spans merge into one', () => {
    // A run finishing at the same instant the next message lands is continuous
    // work; a zero-width seam between them would be an artefact.
    expect(union([{ start: 0, end: 1000 }, { start: 1000, end: 2000 }])).toEqual([
      { start: 0, end: 2000 },
    ])
  })

  test('input order does not matter', () => {
    const a = engagedMs([{ start: 5000, end: 15_000 }, { start: 0, end: 10_000 }])
    const b = engagedMs([{ start: 0, end: 10_000 }, { start: 5000, end: 15_000 }])
    expect(a).toBe(b)
  })

  /**
   * The case the whole model exists for, with the real numbers.
   *
   * This session launched run 378 (grok) and run 379 (codex) from one Claude
   * session in ~/Projects/workshop. 379 started 8s after 378 and finished 26s
   * before it, so it is entirely contained.
   *
   * Summing agent durations says 7m54s of work happened. It did not: 4m14s of
   * wall-clock did, with two agents inside it. And the gap-capped
   * Claude-only model says roughly nothing happened at all, because Claude
   * sent no messages while it waited.
   */
  test('two concurrent delegated runs count as their union, not their sum', () => {
    const run378 = { start: at('2026-09-01T13:32:02.624Z'), end: at('2026-09-01T13:32:02.624Z') + 254_532 }
    const run379 = { start: at('2026-09-01T13:32:10.630Z'), end: at('2026-09-01T13:32:10.630Z') + 220_158 }

    expect(run379.start).toBeGreaterThan(run378.start)
    expect(run379.end).toBeLessThan(run378.end)

    expect(engagedMs([run378, run379])).toBe(254_532)
    expect(254_532 + 220_158).toBe(474_690) // what summing would have claimed
    expect(human(engagedMs([run378, run379]))).toBe('4m 15s')
  })

  test('a delegated run fills a gap Claude left empty', () => {
    // Claude sends a message, waits out a 4-minute agent run, then replies.
    // Under a 10-minute idle cap the Claude pair alone already covers it, but
    // the point is that the union does not double it.
    const t0 = at('2026-09-01T13:32:00.000Z')
    const claude = spansFromTimestamps([t0, t0 + 300_000], DEFAULT_IDLE_CAP_MS)
    const agent = [{ start: t0 + 10_000, end: t0 + 250_000 }]
    expect(engagedMs([...claude, ...agent])).toBe(300_000)
  })
})

describe('daily report untasked bucket', () => {
  test('shows untasked work separately and unions it into ENGAGED once', () => {
    const d = db()
    const now = Date.now()
    const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
    d.query(`INSERT INTO task
      (key, project, title, status, status_category, source, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'LOC-638', 'workshop', 'Ticketed report work', 'In Progress', 'active', 'local', iso(40), iso(5),
    )
    const insert = d.query(`INSERT INTO interval
      (task_key, project, source, start_at, end_at, ref)
      VALUES (?, ?, 'claude', ?, ?, ?)`)
    insert.run('LOC-638', 'workshop', iso(30), iso(10), 'report-ticketed')
    // Overlaps the ticketed span for ten minutes. ENGAGED must be the union:
    // 25 minutes from -30 through -5, not 20 + 15 = 35 minutes.
    insert.run(null, 'workshop', iso(20), iso(5), 'report-untasked')

    const report = {
      enabled: true, to: [], fromName: '', fromAddress: '', subjectPrefix: '',
      smtpHost: '', smtpPort: 0, smtpUser: '', smtpPasswordRef: 'env:TEST',
      windowHours: 1, minMinutes: 0, projects: ['workshop'], briefs: [], testTo: '',
    } as Parameters<typeof gather>[0]
    const g = gather(report)

    expect(g.taskMs).toBe(20 * 60_000)
    expect(g.engagedMs).toBe(25 * 60_000)
    expect(g.projects).toHaveLength(1)
    expect(g.projects[0]!.items.map((i) => i.key)).toEqual(['LOC-638'])
    expect(g.projects[0]!.untasked?.engagedMs).toBe(15 * 60_000)

    const html = renderHtml(g, new Map())
    const text = renderText(g, new Map())
    expect(html).toContain('background:#654321')
    expect(html).toContain('No ticket')
    expect(html).toContain('15m 0s not tied to a ticket')
    expect(text).toContain('NO TICKET')
    expect(text).toContain('15m 0s not tied to a ticket')
  })
})

describe('Eastern timestamps', () => {
  test('uses Eastern time with a 12-hour clock and lowercase am/pm', () => {
    expect(easternTime('2026-09-02T19:07:00.000Z')).toBe('3:07 pm')
    expect(easternTime('2026-09-03T03:07:00.000Z', true)).toBe('Sep 2 11:07 pm')
  })

  test('the daily report renders its timestamp in Eastern time', () => {
    const report = {
      hours: 24, from: '2026-09-02T03:07:00.000Z',
      to: '2026-09-03T03:07:00.000Z', items: [], projects: [],
      taskMs: 0, engagedMs: 0,
    } as ReturnType<typeof gather>

    expect(renderHtml(report, new Map())).toContain('Wednesday, September 2')
  })
})

describe('spans from timestamps', () => {
  test('a single message is no duration at all', () => {
    expect(spansFromTimestamps([at('2026-09-01T10:00:00Z')], DEFAULT_IDLE_CAP_MS)).toEqual([])
  })

  test('a gap under the cap is taken whole', () => {
    const t = at('2026-09-01T10:00:00Z')
    expect(engagedMs(spansFromTimestamps([t, t + 60_000], DEFAULT_IDLE_CAP_MS))).toBe(60_000)
  })

  test('a gap over the cap is truncated, not dropped', () => {
    // Overnight: the work either side is real, the eight hours between is not.
    const t = at('2026-09-01T10:00:00Z')
    expect(engagedMs(spansFromTimestamps([t, t + 8 * 3600_000], DEFAULT_IDLE_CAP_MS)))
      .toBe(DEFAULT_IDLE_CAP_MS)
  })

  test('a capped gap keeps its real start, so an agent run can overlap it', () => {
    // This is why capping happens per-pair rather than at the sum: the span
    // has coordinates, not just a length.
    const t = at('2026-09-01T10:00:00Z')
    const [span] = spansFromTimestamps([t, t + 3600_000], DEFAULT_IDLE_CAP_MS)
    expect(span!.start).toBe(t)
    expect(span!.end).toBe(t + DEFAULT_IDLE_CAP_MS)
  })
})

describe('worktree attribution', () => {
  // The fixture carries every worktree shape the attribution has to preserve.
  test.each([
    ['/fixtures/repos/beta/.claude/worktrees/BET-2533', 'BET-2533'],
    ['/fixtures/repos/beta/.claude/worktrees/BET-2437', 'BET-2437'],
    ['/fixtures/repos/beta/.claude/worktrees/BET-2547', 'BET-2547'],
    ['/fixtures/repos/beta/.claude/worktrees/BET-2548', 'BET-2548'],
    ['/fixtures/repos/alpha/.claude/worktrees/ALP-5347', 'ALP-5347'],
    ['/fixtures/repos/alpha/.claude/worktrees/ALP-5330', 'ALP-5330'],
    ['/fixtures/repos/delta/.claude/worktrees/DEL-708-standings', 'DEL-708'],
    ['/fixtures/repos/delta/.claude/worktrees/worktree-DEL-703-markdown-render', 'DEL-703'],
    // Lowercase, underscores, key in the middle. Anchoring the regex to the
    // start of the directory name would drop exactly this one.
    ['/fixtures/repos/gamma/.claude/worktrees/technical_gam_986_nexus_shell_barrel', 'GAM-986'],
    // A path nested below the worktree root still names its task.
    ['/fixtures/repos/beta/.claude/worktrees/BET-2548/resources/assets/js', 'BET-2548'],
  ])('%s -> %s', (cwd, key) => {
    expect(keyFromWorktree(cwd)).toBe(key)
  })

  test('a plain checkout names no task', () => {
    expect(keyFromWorktree('/fixtures/repos/workshop')).toBeNull()
    expect(keyFromWorktree('/fixtures/repos/beta')).toBeNull()
  })

  test('a prefix inside a word is not a key', () => {
    expect(keyFromWorktree('/fixtures/repos/x/.claude/worktrees/lab-2533')).toBeNull()
  })
})

describe('project attribution', () => {
  test('the process uses the fixture register and its theme colors', () => {
    expect(projectNames()).toContain('alpha')
    expect(projectColor('alpha')).toBe('#112233')
    expect(projectColor('alpha', true)).toBe('#aabbcc')
    expect(projectColor('beta')).toBeNull()
  })

  test('a checkout names its project', () => {
    expect(projectOf('/fixtures/repos/alpha')).toBe('alpha')
    expect(projectOf('/fixtures/repos/workshop/orchestrator')).toBe('workshop')
    expect(projectOf('/fixtures/repos/alpha/packages/nested/src')).toBe('nested')
  })

  test('a numbered clone is the same project', () => {
    // The other machine checks out alpha-0, beta-1 and so on. Missing
    // this once read 65% of a window's canon work as untracked.
    expect(projectOf('/fixtures/repos/alpha-0')).toBe('alpha')
    expect(projectOf('/fixtures/repos/beta-2')).toBe('beta')
  })

  test('anything outside ~/Projects belongs to no project', () => {
    expect(projectOf('/tmp/scratch')).toBeNull()
    expect(projectOf(undefined)).toBeNull()
    expect(projectOf('/fixtures/repos/some-other-repo')).toBeNull()
  })

  test('each prefix routes to its project', () => {
    expect(projectOfKey('ALP-5347')).toBe('alpha')
    expect(projectOfKey('BET-2533')).toBe('beta')
    expect(projectOfKey('GAM-986')).toBe('gamma')
    expect(projectOfKey('DEL-708')).toBe('delta')
    expect(projectOfKey('SHUL-12')).toBe('delta')
    expect(projectOfKey('LOC-1')).toBe('workshop')
    expect(projectOfKey('NOPE-1')).toBeNull()
  })
})

describe('tracker register', () => {
  test('only projects that declare a usable tracker are polled', async () => {
    const results = await ingestTrackers()
    expect(results.map((result) => result.project)).toEqual(['alpha'])
    expect(results[0]!.skipped).toContain('FIXTURE_NO_CREDENTIALS_MCP_URL')
  })
})

describe('tracker assignees', () => {
  test('resolves an id once and reuses the cached display name', async () => {
    const cache = new Map<string, string | null>()
    let calls = 0
    const lookup = async () => { calls++; return 'Ada Lovelace' }
    expect(await resolveAssigneeIds([{ id: 2 }], cache, lookup)).toEqual(['Ada Lovelace'])
    expect(await resolveAssigneeIds([{ id: 2 }], cache, lookup)).toEqual(['Ada Lovelace'])
    expect(calls).toBe(1)
  })

  test('caches an id that does not resolve', async () => {
    const cache = new Map<string, string | null>()
    let calls = 0
    const lookup = async () => { calls++; return null }
    expect(await resolveAssigneeIds([{ id: 'missing' }], cache, lookup)).toEqual([null])
    expect(await resolveAssigneeIds([{ id: 'missing' }], cache, lookup)).toEqual([null])
    expect(calls).toBe(1)
  })

  test('a tracker reporting no assignee makes no lookup and leaves null', async () => {
    let calls = 0
    const names = await resolveAssigneeIds([{}], new Map(), async () => { calls++; return 'wrong' })
    expect(names).toEqual([null])
    expect(calls).toBe(0)

    upsertTrackerTask({
      key: 'ALP-899', project: 'alpha', title: 'No assignment field', status: 'started',
      category: 'active', updatedAt: null, assignee: null,
    })
    expect(showTask('ALP-899').task.assignee).toBeNull()
  })
})

describe('local task tracker', () => {
  const seed = (key: string, project: string, source: 'mcp' | 'local' = 'local') => {
    const stamp = new Date().toISOString()
    db().query(
      `INSERT INTO task
        (key, project, title, status, status_category, source, first_seen, last_seen)
       VALUES (?, ?, 'seed', 'open', 'open', ?, ?, ?)`,
    ).run(key, project, source, stamp, stamp)
  }

  test('issues above the highest existing number for the project prefix', () => {
    seed('BET-700', 'beta')
    expect(createTask({ project: 'beta', title: 'Next beta task' }).key).toBe('BET-701')
  })

  test('an mcp-sourced key participates in issuance and cannot collide', () => {
    seed('ALP-900', 'alpha', 'mcp')
    const task = createTask({ project: 'alpha', title: 'After tracker task' })
    expect(task.key).toBe('ALP-901')
    expect(showTask('ALP-900').task.source).toBe('mcp')
  })

  test('refuses issuance when the registered project has no prefix', () => {
    expect(() => createTask({ project: 'nested', title: 'Cannot number this' }))
      .toThrow(`orch project set nested --settings '{"keyPrefixes":["ABC"]}'`)
  })

  test('stores a parent and exposes the child through the same task row', () => {
    const parent = createTask({ project: 'workshop', title: 'Parent' })
    const child = createTask({ project: 'workshop', title: 'Child', parent: parent.key })
    expect(child.parent_key).toBe(parent.key)
    expect(showTask(child.key).task.parent_key).toBe(parent.key)
  })

  test('a local task survives the tracker ingest write path', () => {
    const local = createTask({ project: 'gamma', title: 'Keep this local', body: 'Local body' })
    db().query(`UPDATE task SET assignee = 'Local Owner' WHERE key = ?`).run(local.key)
    upsertTrackerTask({
      key: local.key, project: 'gamma', title: 'Tracker replacement', status: 'done',
      category: 'done', updatedAt: '2026-09-02T00:00:00.000Z', assignee: 'Tracker Owner',
    })
    const after = showTask(local.key).task
    expect(after.source).toBe('local')
    expect(after.title).toBe('Keep this local')
    expect(after.status_category).toBe('open')
    expect(after.body).toBe('Local body')
    expect(after.assignee).toBe('Local Owner')
  })
})

describe('attribute()', () => {
  test('a worktree beats a commit subject', () => {
    const a = attribute({
      cwd: '/fixtures/repos/beta/.claude/worktrees/BET-2533',
      commitSubjects: ['BET-9999 something else'],
    })
    expect(a).toEqual({ project: 'beta', key: 'BET-2533', via: 'worktree' })
  })

  test('a commit subject beats prompt prose', () => {
    const a = attribute({
      cwd: '/fixtures/repos/alpha',
      commitSubjects: ['ALP-5347 fix the thing'],
      prompts: ['also have a look at ALP-1111'],
    })
    expect(a).toEqual({ project: 'alpha', key: 'ALP-5347', via: 'commit' })
  })

  test('prompt prose is the last resort', () => {
    const a = attribute({ cwd: '/fixtures/repos/alpha', prompts: ['work on ALP-5347 please'] })
    expect(a).toEqual({ project: 'alpha', key: 'ALP-5347', via: 'prompt' })
  })

  test('an injected payload never names a task', () => {
    // A pasted review pack or system reminder quoting a key is not evidence
    // that anyone worked on it.
    const a = attribute({
      cwd: '/fixtures/repos/alpha',
      prompts: ['<system-reminder>see ALP-5347 for context</system-reminder>'],
    })
    expect(a).toEqual({ project: 'alpha', key: null, via: null })
  })

  test("a key from another project's prose is ignored", () => {
    // An alpha session discussing a beta ticket is not time on it.
    const a = attribute({ cwd: '/fixtures/repos/alpha', prompts: ['like we did in BET-2533'] })
    expect(a).toEqual({ project: 'alpha', key: null, via: null })
  })

  test('no key at all is a real answer, not a failure', () => {
    const a = attribute({ cwd: '/fixtures/repos/workshop', prompts: ['refactor the collector'] })
    expect(a).toEqual({ project: 'workshop', key: null, via: null })
  })

  test('a branch name declares its ticket, in every shape the estate uses', () => {
    // Same matcher as a worktree path, because the shapes are the same and for
    // the same reason: `_` is a word character, so an anchored or \\b-guarded
    // pattern silently drops `technical_gam_986_...` while looking correct.
    expect(keyFromBranch('technical/ALP-5362-delete-the-classes', 'alpha')).toBe('ALP-5362')
    expect(keyFromBranch('BET-2533', 'beta')).toBe('BET-2533')
    expect(keyFromBranch('technical_gam_986_nexus_shell_barrel', 'gamma')).toBe('GAM-986')
    // develop is where the main checkouts sit, and it declares nothing.
    expect(keyFromBranch('develop', 'alpha')).toBeNull()
    expect(keyFromBranch(null, 'alpha')).toBeNull()
    // Cross-project chatter is not time spent: same rule prose keys follow.
    expect(keyFromBranch('BET-2533', 'alpha')).toBeNull()
  })

  test('the project never depends on whether a task was identified', () => {
    // The two are decided by different things - the project by the working
    // directory, the task by whatever named it - and the project roll-up must
    // therefore be untouched by any change to task attribution. This is what
    // makes it safe to drop a bad key rather than keep it: the hours stay on
    // the right project, they just stop claiming a task they did not belong to.
    const cwd = '/fixtures/repos/alpha'
    const named = attribute({ cwd, prompts: ['work on ALP-5347 please'] })
    const silent = attribute({ cwd, prompts: ['just make the tests pass'] })
    const worktree = attribute({ cwd: `${cwd}/.claude/worktrees/ALP-5347/app` })
    expect(named.key).not.toBeNull()
    expect(silent.key).toBeNull()
    expect([named.project, silent.project, worktree.project]).toEqual(
      ['alpha', 'alpha', 'alpha'],
    )
  })
})

describe('injected markers', () => {
  test.each([
    '<system-reminder>anything</system-reminder>',
    '<command-name>/foo</command-name>',
    'This session is being continued from a previous conversation',
    '<task-notification>done</task-notification>',
  ])('%s is injected', (text) => {
    expect(isInjected(text)).toBe(true)
  })

  test('ordinary prose is not', () => {
    expect(isInjected('please fix the failing test in ALP-5347')).toBe(false)
  })
})

describe('human durations', () => {
  test.each([
    [0, '0s'],
    [12_000, '12s'],
    [90_000, '1m 30s'],
    [254_532, '4m 15s'],
    [3600_000, '1h 0m'],
    [8_040_000, '2h 14m'],
  ])('%i ms -> %s', (ms, out) => {
    expect(human(ms)).toBe(out)
  })
})

describe('spend conservation', () => {
  // The property that makes reconciliation against the day grain meaningful:
  // every token a leg saw comes back out, whatever the spans look like.
  //
  // It is asserted because losing tokens here is silent. An earlier cut
  // apportioned a leg's spend across its spans by duration and dropped every
  // token from a leg too short to have a span at all — 1.35 billion tokens on
  // one day, 32% of it, with no error and no empty column to notice.
  const conserved = (stamps: number[], spend: { at: number; tokens: number }[]) => {
    const leg = { cwd: '/fixtures/repos/workshop', ref: 'r', stamps, prompts: [], spend }
    const out = spendingSpans(leg, DEFAULT_IDLE_CAP_MS)
    return out.reduce((t, s) => t + s.tokens, 0)
  }
  const t = at('2026-09-01T10:00:00Z')

  test('a normal leg keeps every token', () => {
    expect(conserved(
      [t, t + 60_000, t + 120_000],
      [{ at: t, tokens: 100 }, { at: t + 60_000, tokens: 200 }, { at: t + 120_000, tokens: 300 }],
    )).toBe(600)
  })

  test('the last message sits on a span boundary and is still counted', () => {
    // A strict `< end` test drops exactly this one, because the final span
    // ends at the final timestamp.
    expect(conserved([t, t + 60_000], [{ at: t + 60_000, tokens: 500 }])).toBe(500)
  })

  test('a single-message leg keeps its spend and reports no duration', () => {
    const leg = { cwd: '/fixtures/repos/workshop', ref: 'r', stamps: [t], prompts: [],
                  spend: [{ at: t, tokens: 900 }] }
    const out = spendingSpans(leg, DEFAULT_IDLE_CAP_MS)
    expect(out).toHaveLength(1)
    expect(out[0]!.tokens).toBe(900)
    expect(out[0]!.end - out[0]!.start).toBe(0) // spend without measurable time
    expect(engagedMs(out)).toBe(0)
  })

  test('spend after a capped gap is still counted', () => {
    // The span ends 10 minutes in; the message lands an hour later. It must
    // land in a span rather than falling through the gap.
    expect(conserved([t, t + 3600_000], [{ at: t + 3600_000, tokens: 77 }])).toBe(77)
  })

  test('a leg with no spend at all emits nothing', () => {
    const leg = { cwd: '/fixtures/repos/workshop', ref: 'r', stamps: [t], prompts: [], spend: [] }
    expect(spendingSpans(leg, DEFAULT_IDLE_CAP_MS)).toEqual([])
  })
})
