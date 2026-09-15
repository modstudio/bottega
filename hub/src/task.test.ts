import { beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db } from './db.ts'
import { DUPLICATE_TITLE_FIXTURE } from './duplicate-matcher.fixture.ts'
import { upsertTrackerTask } from './ingest/trackers.ts'
import {
  commentTask,
  createTask,
  createTaskDocument,
  duplicateCandidates,
  duplicateScore,
  showTask,
  taskRecord,
} from './task.ts'

beforeAll(resetFixtureStore)

describe('local task tracker', () => {
  const seed = (key: string, project: string, source: 'mcp' | 'local' = 'local') => {
    const stamp = new Date().toISOString()
    db()
      .query(
        `INSERT INTO task
        (key, project, title, status, status_category, source, first_seen, last_seen)
       VALUES (?, ?, 'seed', 'open', 'open', ?, ?, ?)`,
      )
      .run(key, project, source, stamp, stamp)
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
    expect(() => createTask({ project: 'nested', title: 'Cannot number this' })).toThrow(
      `orch project set nested --settings '{"keyPrefixes":["ABC"]}'`,
    )
  })

  test('refuses an unusable title at the shared creation boundary', () => {
    expect(() => createTask({ project: 'workshop', title: '' })).toThrow('task title is required')
    expect(() => createTask({ project: 'workshop', title: ' \n ' })).toThrow(
      'task title is required',
    )
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
      key: local.key,
      project: 'gamma',
      title: 'Tracker replacement',
      status: 'done',
      category: 'done',
      updatedAt: '2026-09-02T00:00:00.000Z',
      assignee: 'Tracker Owner',
    })
    const after = showTask(local.key).task
    expect(after.source).toBe('local')
    expect(after.title).toBe('Keep this local')
    expect(after.status_category).toBe('open')
    expect(after.body).toBe('Local body')
    expect(after.assignee).toBe('Local Owner')
  })

  test('duplicate title matching is deterministic, thresholded, and capped at three', () => {
    const tasks = [
      ['DEV-4', 'open', 'alpha beta gamma delta epsilon'],
      ['DEV-3', 'done', 'alpha beta gamma delta zeta'],
      ['DEV-2', 'active', 'alpha beta gamma delta eta'],
      ['DEV-1', 'open', 'alpha beta gamma delta theta'],
      ['DEV-5', 'open', 'unrelated words only'],
    ].map(([key, status, title]) => ({
      key: key!,
      project: 'workshop',
      status: status!,
      status_category: 'open' as const,
      title: title!,
      parent_key: null,
      body: null,
      assignee: null,
      opened_at: null,
      closed_at: null,
      updated_at: null,
      source: 'local' as const,
      first_seen: '',
      last_seen: '',
    }))

    expect(duplicateCandidates(tasks, 'alpha beta gamma delta')).toEqual([
      expect.objectContaining({ key: 'DEV-1' }),
      expect.objectContaining({ key: 'DEV-2' }),
      expect.objectContaining({ key: 'DEV-3' }),
    ])
  })

  test('prints the four known duplicate-matcher measurements', () => {
    const scores = {
      'DEV-209/DEV-210': duplicateScore(
        DUPLICATE_TITLE_FIXTURE['DEV-209'],
        DUPLICATE_TITLE_FIXTURE['DEV-210'],
      ),
      'DEV-265/DEV-266': duplicateScore(
        DUPLICATE_TITLE_FIXTURE['DEV-265'],
        DUPLICATE_TITLE_FIXTURE['DEV-266'],
      ),
      'DEV-293/DEV-294': duplicateScore(
        DUPLICATE_TITLE_FIXTURE['DEV-293'],
        DUPLICATE_TITLE_FIXTURE['DEV-294'],
      ),
      'best unrelated': duplicateScore(
        DUPLICATE_TITLE_FIXTURE['DEV-251'],
        DUPLICATE_TITLE_FIXTURE['DEV-266'],
      ),
    }
    console.log('duplicate matcher scores', scores)
    expect(scores['DEV-209/DEV-210']).toBeGreaterThanOrEqual(0.2)
    expect(scores['DEV-265/DEV-266']).toBeGreaterThanOrEqual(0.2)
    expect(scores['DEV-293/DEV-294']).toBeLessThan(0.2)
    expect(scores['best unrelated']).toBeLessThan(0.2)
  })

  test('work.task returns the local record with comments, documents, runs and project', async () => {
    const task = createTask({ project: 'workshop', title: 'Inspectable task', body: 'Task body' })
    const comment = commentTask(task.key, 'A useful comment')
    const ordinary = createTaskDocument({ task: task.key, title: 'Notes', body: '# Notes' })
    const handoff = createTaskDocument({
      task: task.key,
      title: 'Handoff',
      body: '# Handoff',
      role: 'handoff',
    })
    db()
      .query(
        `INSERT INTO interval
        (task_key, project, source, agent, job, start_at, end_at, vendor_tokens, ref, open)
       VALUES (?, 'workshop', 'orch', 'codex', 'implement', ?, ?, 123, 'orch:1812', 0)`,
      )
      .run(task.key, '2026-09-05T10:00:00.000Z', '2026-09-05T10:01:00.000Z')
    db()
      .query(
        `INSERT INTO interval
        (task_key, project, source, agent, job, start_at, end_at, vendor_tokens, ref, open)
       VALUES (?, 'workshop', 'orch', 'codex', 'implement', ?, ?, 45, 'orch:1812:turn:1813', 0)`,
      )
      .run(task.key, '2026-09-05T10:02:00.000Z', '2026-09-05T10:03:00.000Z')

    const result = taskRecord(task.key.toLowerCase())
    expect(result.task).toMatchObject({ key: task.key, title: 'Inspectable task' })
    expect(result.source).toBe('local')
    expect(result.project?.name).toBe('workshop')
    expect(result.capabilities).toMatchObject({
      setStatus: { allowed: true },
      setTitle: { allowed: true },
      comment: { allowed: true },
      documents: { allowed: true },
    })
    expect(result.comments).toEqual([comment])
    expect(result.documents.map((document) => document.id)).toEqual([handoff.id, ordinary.id])
    expect(result.documents[0]?.body).toBe('# Handoff')
    expect(result.runs).toEqual([
      expect.objectContaining({ id: 1813, agent: 'codex', vendor_tokens: 45 }),
      expect.objectContaining({ id: 1812, agent: 'codex', vendor_tokens: 123 }),
    ])
    expect(taskRecord(task.key).task.key).toBe(task.key)
  })
})
