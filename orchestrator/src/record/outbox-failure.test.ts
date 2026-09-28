import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import {
  classifyOutboxFailure,
  type OutboxFailureFacts,
  outboxFailureDisposition,
} from './outbox-failure.ts'

const classify = (facts: Partial<OutboxFailureFacts>) =>
  classifyOutboxFailure({
    sqlState: null,
    serverMessage: null,
    errorClass: 'unknown',
    responseReceived: false,
    ...facts,
  })

describe('hosted record outbox failure classification', () => {
  test.each([
    [
      'row-level security',
      {
        sqlState: '42501',
        serverMessage: 'new row violates row-level security policy for table "run"',
        responseReceived: true,
      },
    ],
    ['check constraint', { sqlState: '23514', responseReceived: true }],
    ['verdict rule', { errorClass: 'verdict-rule', responseReceived: true }],
    ['unexpected column set', { errorClass: 'payload' }],
    ['declared space refusal', { errorClass: 'declared-space' }],
  ] satisfies Array<[string, Partial<OutboxFailureFacts>]>)('%s is row-fatal', (_name, facts) => {
    expect(classify(facts)).toBe('row-fatal')
  })

  test.each([
    ['connection refused', { responseReceived: false }],
    ['connection SQLSTATE', { sqlState: '08006', responseReceived: true }],
    ['authentication', { sqlState: '28P01', responseReceived: true }],
    ['session shutdown', { sqlState: '57P01', responseReceived: true }],
    ['missing migration column', { sqlState: '42703', responseReceived: true }],
    ['explicit migration mismatch', { errorClass: 'migration-mismatch', responseReceived: true }],
  ] satisfies Array<[string, Partial<OutboxFailureFacts>]>)('%s is pass-fatal', (_name, facts) => {
    expect(classify(facts)).toBe('pass-fatal')
  })

  test('Bun PostgreSQL errors use errno for SQLSTATE and distinguish RLS from a missing grant', () => {
    const rls = new SQL.PostgresError(
      'new row violates row-level security policy for table "run"',
      { code: 'ERR_POSTGRES_SERVER_ERROR', errno: 42501 as unknown as string },
    )
    const constraint = new SQL.PostgresError('check constraint failed', {
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: 23514 as unknown as string,
    })
    const grant = new SQL.PostgresError('permission denied for table run', {
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: 42501 as unknown as string,
    })
    const connection = new SQL.PostgresError('connection refused', {
      code: 'ERR_POSTGRES_CONNECTION_REFUSED',
    })

    expect(outboxFailureDisposition(new Error('wrapped', { cause: rls }))).toBe('row-fatal')
    expect(outboxFailureDisposition(constraint)).toBe('row-fatal')
    expect(outboxFailureDisposition(grant)).toBe('pass-fatal')
    expect(outboxFailureDisposition(connection)).toBe('pass-fatal')
  })
})
