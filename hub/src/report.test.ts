import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { engagedMs } from '../../shared/interval.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db } from './db.ts'
import { upsertTrackerTask } from './ingest/trackers.ts'
import { boardTasks, endMs, stripWindow } from './query.ts'
import { gather, renderHtml, renderText } from './report.ts'
import { clearOrchCache, view } from './serve.ts'
import { createTask, taskRecord } from './task.ts'

beforeAll(resetFixtureStore)
afterEach(clearOrchCache)

describe('daily report untasked bucket', () => {
  test('shows untasked work separately and unions it into ENGAGED once', () => {
    const d = db()
    const now = Date.now()
    const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
    d.query(`INSERT INTO task
      (key, project, title, status, status_category, source, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'LOC-638',
      'workshop',
      'Ticketed report work',
      'In Progress',
      'active',
      'local',
      iso(40),
      iso(5),
    )
    const insert = d.query(`INSERT INTO interval
      (task_key, project, source, start_at, end_at, ref)
      VALUES (?, ?, 'claude', ?, ?, ?)`)
    insert.run('LOC-638', 'workshop', iso(30), iso(10), 'report-ticketed')
    // Overlaps the ticketed span for ten minutes. ENGAGED must be the union:
    // 25 minutes from -30 through -5, not 20 + 15 = 35 minutes.
    insert.run(null, 'workshop', iso(20), iso(5), 'report-untasked')

    const report = {
      enabled: true,
      to: [],
      fromName: '',
      fromAddress: '',
      subjectPrefix: '',
      smtpHost: '',
      smtpPort: 0,
      smtpUser: '',
      smtpPasswordRef: 'env:TEST',
      windowHours: 1,
      minMinutes: 0,
      projects: ['workshop'],
      briefs: [],
      testTo: '',
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
  test('the daily report renders its timestamp in Eastern time', () => {
    const report = {
      hours: 24,
      from: '2026-09-02T03:07:00.000Z',
      to: '2026-09-03T03:07:00.000Z',
      items: [],
      projects: [],
      taskMs: 0,
      engagedMs: 0,
    } as ReturnType<typeof gather>

    expect(renderHtml(report, new Map())).toContain('Wednesday, September 2')
  })
})

describe('heterogeneous work rows', () => {
  test('the windowed strip returns the same rows as the unfiltered task join', () => {
    const task = createTask({ project: 'workshop', title: 'Strip window fixture' })
    db()
      .query(
        `INSERT INTO interval
        (task_key, project, source, start_at, end_at, ref, open, claude_tokens)
       VALUES (?, 'workshop', 'claude', ?, ?, 'strip:task', 0, 11),
              (NULL, 'alpha', 'orch', ?, ?, 'strip:untracked', 0, 0),
              (?, 'workshop', 'claude', ?, ?, 'strip:outside', 0, 99)`,
      )
      .run(
        task.key,
        '2031-01-02T10:00:00.000Z',
        '2031-01-02T11:00:00.000Z',
        '2031-01-02T10:30:00.000Z',
        '2031-01-02T11:30:00.000Z',
        task.key,
        '2030-01-01T00:00:00.000Z',
        '2030-01-01T01:00:00.000Z',
      )
    const from = '2031-01-02T09:00:00.000Z'
    const to = '2031-01-02T12:00:00.000Z'
    type LegacyInterval = {
      task_key: string | null
      project: string | null
      source: string
      start_at: string
      end_at: string
      open: number
      claude_tokens: number
    }
    const intervals = db()
      .query<LegacyInterval, [string, string]>(
        `SELECT task_key, project, source, start_at, end_at, open, claude_tokens
         FROM interval WHERE end_at >= ? AND start_at < ? ORDER BY start_at`,
      )
      .all(from, to)
    const meta = new Map(
      db()
        .query<
          {
            key: string
            project: string
            title: string | null
            status_category: string | null
            source: string | null
          },
          []
        >(`SELECT key, project, title, status_category, source FROM task`)
        .all()
        .map((row) => [row.key, row]),
    )
    const groups = new Map<string, LegacyInterval[]>()
    for (const row of intervals) {
      const id = row.task_key ?? `\0unattributed:${row.project ?? 'unknown'}`
      const list = groups.get(id) ?? []
      list.push(row)
      groups.set(id, list)
    }
    const legacy = [...groups.entries()]
      .map(([id, list]) => {
        const key = id.startsWith('\0') ? null : id
        const taskRow = key ? meta.get(key) : undefined
        return {
          key,
          project: taskRow?.project ?? list[0]!.project,
          title: taskRow?.title ?? null,
          statusCategory: taskRow?.status_category ?? null,
          source: taskRow?.source ?? (key ? 'git' : null),
          engagedMs: engagedMs(
            list.map((row) => ({
              start: new Date(row.start_at).getTime(),
              end: endMs(row),
            })),
          ),
          claudeTokens: list.reduce((sum, row) => sum + row.claude_tokens, 0),
          intervals: list.length,
        }
      })
      .sort((a, b) => `${a.key}:${a.project}`.localeCompare(`${b.key}:${b.project}`))
    const current = stripWindow(from, to)
      .tasks.map((row) => ({
        key: row.key,
        project: row.project,
        title: row.title,
        statusCategory: row.statusCategory,
        source: row.source,
        engagedMs: row.engagedMs,
        claudeTokens: row.claudeTokens,
        intervals: row.intervals,
      }))
      .sort((a, b) => `${a.key}:${a.project}`.localeCompare(`${b.key}:${b.project}`))

    expect(current).toEqual(legacy)
    expect(current).toHaveLength(2)
  })

  test('row assembly attaches capabilities and the source filter narrows before serving', async () => {
    const local = createTask({ project: 'workshop', title: 'Source-filter local row' })
    upsertTrackerTask({
      key: 'ALP-999',
      project: 'alpha',
      title: 'Source-filter external row',
      status: 'started',
      category: 'active',
      updatedAt: null,
      assignee: null,
    })
    const now = new Date(Date.now() - 1000).toISOString()
    for (const [key, project] of [
      [local.key, 'workshop'],
      ['ALP-999', 'alpha'],
    ] as const) {
      db()
        .query(
          `INSERT INTO interval
          (task_key, project, source, start_at, end_at, ref, open)
         VALUES (?, ?, 'claude', ?, ?, ?, 1)`,
        )
        .run(key, project, now, now, `filter:${key}`)
    }

    const hub = (await view('flight', 24, { agent: '', project: '', source: 'hub' })) as {
      rows: { key: string; capabilities: { setTitle: { allowed: boolean } } }[]
    }
    expect(hub.rows.length).toBeGreaterThan(0)
    expect(hub.rows.every((row) => row.capabilities.setTitle.allowed)).toBeTrue()

    const external = (await view('flight', 24, { agent: '', project: '', source: 'alpha' })) as {
      rows: { key: string; capabilities: { setTitle: { allowed: boolean } } }[]
    }
    expect(external.rows.length).toBeGreaterThan(0)
    expect(external.rows.every((row) => !row.capabilities.setTitle.allowed)).toBeTrue()

    expect(boardTasks().cards.find((card) => card.key === 'ALP-999')?.capabilities).toMatchObject({
      create: { allowed: false },
      setStatus: { allowed: false },
      statusVocabulary: ['started', 'completed'],
    })
    expect(taskRecord('ALP-999').sourceProtocol).toBe('workspace-mcp')
  })

  test('the unmapped footnote counts only rows this view excludes', async () => {
    for (const [key, raw] of [
      ['ALP-997', 'Awaiting Oracle'],
      ['ALP-998', 'Vendor Mystery'],
    ] as const) {
      upsertTrackerTask({
        key,
        project: 'alpha',
        title: raw,
        status: raw,
        category: 'active',
        updatedAt: null,
        assignee: null,
      })
      db().query('UPDATE task SET status_category = NULL WHERE key = ?').run(key)
    }
    const now = new Date().toISOString()
    const started = new Date(Date.now() - 1_000).toISOString()
    const oldStart = new Date(Date.now() - 3_601_000).toISOString()
    const oldEnd = new Date(Date.now() - 3_600_000).toISOString()
    db()
      .query(
        `INSERT INTO interval
        (task_key, project, source, start_at, end_at, ref, open)
       VALUES ('ALP-997', 'alpha', 'claude', ?, ?, 'unmapped:excluded', 0),
              ('ALP-998', 'alpha', 'claude', ?, ?, 'unmapped:shown', 1)`,
      )
      .run(oldStart, oldEnd, started, now)

    const result = (await view('flight', 24, { agent: '', project: '', source: 'alpha' })) as {
      rows: { key: string }[]
      dropped: { reason: string }[]
      unmappedStatuses: { count: number; words: string[] }
    }
    expect(result.rows.some((row) => row.key === 'ALP-998')).toBeTrue()
    expect(result.rows.some((row) => row.key === 'ALP-997')).toBeFalse()
    expect(result.unmappedStatuses.words).toContain('Awaiting Oracle')
    expect(result.unmappedStatuses.words).not.toContain('Vendor Mystery')
    expect(result.dropped.some((item) => item.reason.includes('no tracker reachable'))).toBeFalse()
  })
})
