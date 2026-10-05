import { expect, test } from 'bun:test'
import { classifyBoardId, decideBoardIdMode, decideBoardMode } from './board-mode.ts'

test('board id shape classification is independent of install mode', () => {
  expect(classifyBoardId('42')).toBe('local')
  expect(classifyBoardId('01990000-0000-7000-8000-000000000001')).toBe('hosted')
  expect(classifyBoardId('not-an-id')).toBe('invalid')
  expect(classifyBoardId('0')).toBe('invalid')
  expect(classifyBoardId(String(Number.MAX_SAFE_INTEGER + 1))).toBe('invalid')
})

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

test('positive integer ids always select the local store', () => {
  expect(decideBoardIdMode({ id: '42', adopted: true, hostedConfigured: true })).toEqual({
    mode: 'local',
  })
  expect(decideBoardIdMode({ id: '42', adopted: true, hostedConfigured: false })).toEqual({
    mode: 'local',
  })
})

test('UUID ids select hosted only after adoption with configuration', () => {
  const id = '01990000-0000-7000-8000-000000000001'
  expect(decideBoardIdMode({ id, adopted: true, hostedConfigured: true })).toEqual({
    mode: 'hosted',
  })
  expect(decideBoardIdMode({ id, adopted: false, hostedConfigured: true })).toEqual({
    mode: 'refused',
    reason:
      'board id is a UUID for a hosted board row, but this install has not adopted the hosted board; retry from an install that has adopted the hosted board',
  })
  expect(decideBoardIdMode({ id, adopted: true, hostedConfigured: false })).toEqual({
    mode: 'refused',
    reason:
      'this install has adopted the hosted board but ORCH_RECORD_API_URL is not configured; configure the hosted record API and sign in with orch record sign-in',
  })
})

test('an id of neither shape names both accepted shapes', () => {
  expect(
    decideBoardIdMode({
      id: 'not-an-id',
      noun: 'board claim id',
      adopted: true,
      hostedConfigured: true,
    }),
  ).toEqual({
    mode: 'refused',
    reason:
      'board claim id must be either a positive integer string for a local SQLite board row or a UUID for a hosted board row',
  })
})
