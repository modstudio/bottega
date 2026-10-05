import { expect, test } from 'bun:test'
import { decideBoardMode } from './board-mode.ts'

test.each(['machine-audience', 'suggestion', 'own-architect'] as const)(
  '%s operations stay local even after adoption',
  (locality) => {
    expect(decideBoardMode({ adopted: true, hostedConfigured: true, locality })).toEqual({
      mode: 'local',
    })
  },
)

test('shared operations stay local before adoption', () => {
  expect(decideBoardMode({ adopted: false, hostedConfigured: true, locality: 'shared' })).toEqual({
    mode: 'local',
  })
})

test('shared operations use hosted mode only after adoption with configuration', () => {
  expect(decideBoardMode({ adopted: true, hostedConfigured: true, locality: 'shared' })).toEqual({
    mode: 'hosted',
  })
})

test('an adopted install refuses rather than falling back without configuration', () => {
  const decision = decideBoardMode({ adopted: true, hostedConfigured: false, locality: 'shared' })
  expect(decision.mode).toBe('refused')
  if (decision.mode === 'refused') {
    expect(decision.reason).toContain('ORCH_RECORD_API_URL')
    expect(decision.reason).toContain('orch record sign-in')
  }
})
