import { describe, expect, test } from 'bun:test'
import { db } from './db.ts'
import { summary } from './metric.ts'

describe('metric canon headline and calendar halves', () => {
  test('headline uses canon totals and excluded days do not move the midpoint', () => {
    const day = (ago: number) => {
      const d = new Date()
      d.setDate(d.getDate() - ago)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      return `${y}-${m}-${String(d.getDate()).padStart(2, '0')}`
    }
    const insert = db().query(
      `INSERT INTO metric (day, claude_tokens, cache_read, messages, tasks,
                           canon_tokens, other_tokens, collected_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    for (const [ago, canon, other, tasks] of [
      [13, 300, 30, 3],
      [12, 300, 30, 3],
      [10, 1, 0, 100],
      [2, 150, 15, 3],
      [1, 150, 15, 3],
    ])
      insert.run(day(ago), canon + other, 0, 1, tasks, canon, other, new Date().toISOString())

    const s = summary(14)
    expect(s.canonTokens).toBe(900)
    expect(s.tokens).toBe(990)
    expect(s.otherTokens).toBe(90)
    expect(s.perTask).toBe(75)
    expect(s.earlier).toEqual({ tokens: 600, tasks: 6, perTask: 100 })
    expect(s.recent).toEqual({ tokens: 300, tasks: 6, perTask: 50 })
    expect(s.direction).toBe('improving')
    db().exec('DELETE FROM metric')
  })
})
