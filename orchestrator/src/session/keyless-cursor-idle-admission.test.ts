import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { KEYLESS_CURSOR_IDLE_MS } from './keyless-cursor-idle.ts'
import { decideKeylessCursorIdleAdmission } from './keyless-cursor-idle-admission.ts'

const now = Date.parse('2026-11-17T12:00:00.000Z')
const cursor = (change: Partial<Parameters<typeof decideKeylessCursorIdleAdmission>[0]['cursors'][number]> = {}) => ({
  number: 970,
  project: PLATFORM_SLUG,
  workflow: 'intake',
  key: '',
  updatedAt: new Date(now - KEYLESS_CURSOR_IDLE_MS).toISOString(),
  questionNumber: null,
  ...change,
})

test('refuses each new-work verb on an idle keyless cursor and names all remedies', () => {
  for (const action of ['run start', 'workflow compose', 'task new'] as const) {
    const decision = decideKeylessCursorIdleAdmission({ action, now, cursors: [cursor()] })
    expect(decision.kind).toBe('refuse')
    if (decision.kind === 'refuse') {
      expect(decision.message).toContain(`${PLATFORM_SLUG} ${action}`)
      expect(decision.message).toContain('intake cursor 970')
      expect(decision.message).toContain('workflow next --cursor 970')
      expect(decision.message).toContain('workflow await --cursor 970')
      expect(decision.message).toContain('workflow abandon --cursor 970')
    }
  }
})

test('admits fresh, keyed, and question-parked cursors', () => {
  for (const candidate of [
    cursor({ updatedAt: new Date(now - KEYLESS_CURSOR_IDLE_MS + 1).toISOString() }),
    cursor({ key: 'DEV-1' }),
    cursor({ questionNumber: 6833 }),
  ]) {
    expect(
      decideKeylessCursorIdleAdmission({ action: 'run start', now, cursors: [candidate] }),
    ).toEqual({ kind: 'allow' })
  }
})
