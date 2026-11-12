import { describe, expect, test } from 'bun:test'
import { decideSessionStart } from './session-start-decision.ts'

describe('session start decision', () => {
  test('composes when the session holds no explore cursor', () => {
    expect(decideSessionStart({ session: 'session', project: 'fixture', cursors: [] })).toEqual({
      kind: 'compose',
    })
  })

  test('reuses an open explore cursor', () => {
    expect(
      decideSessionStart({
        session: 'session',
        project: 'fixture',
        cursors: [{ id: 17, workflow: 'explore', state: 'active' }],
      }),
    ).toEqual({ kind: 'reuse', cursor: 17, workflow: 'explore' })
  })

  test('keeps a task workflow the session took up after closing explore', () => {
    expect(
      decideSessionStart({
        session: 'session',
        project: 'fixture',
        cursors: [
          { id: 17, workflow: 'explore', state: 'done' },
          { id: 18, workflow: 'plan-task', state: 'active' },
          { id: 21, workflow: 'ship-task', state: 'active' },
        ],
      }),
    ).toEqual({ kind: 'reuse', cursor: 21, workflow: 'ship-task' })
  })

  test('refuses softly outside a registered project', () => {
    expect(decideSessionStart({ session: 'session', project: null, cursors: [] })).toEqual({
      kind: 'refuse-project',
    })
  })
})
