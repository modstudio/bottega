import { describe, expect, test } from 'bun:test'
import { answerRunLivenessRefusal } from './run-answer-liveness.ts'

describe('answer run liveness', () => {
  test('a continuation child asking under an ok root proceeds', () => {
    expect(
      answerRunLivenessRefusal({ status: 'ok', voided: false }, [{ owner_status: 'asking' }]),
    ).toBeNull()
  })

  test('a voided root refuses', () => {
    expect(
      answerRunLivenessRefusal({ status: 'asking', voided: true }, [{ owner_status: 'asking' }]),
    ).toBe('voided')
  })

  test('all terminal owners refuse with an owner status', () => {
    expect(
      answerRunLivenessRefusal({ status: 'running', voided: false }, [
        { owner_status: 'failed' },
        { owner_status: 'stopped' },
      ]),
    ).toBe('failed')
  })

  test('a root that is itself asking proceeds', () => {
    expect(
      answerRunLivenessRefusal({ status: 'asking', voided: false }, [{ owner_status: 'asking' }]),
    ).toBeNull()
  })
})
