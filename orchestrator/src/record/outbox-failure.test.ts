import { describe, expect, test } from 'bun:test'
import { classifyOutboxFailure, type OutboxFailureFacts } from './outbox-failure.ts'

const classify = (facts: Partial<OutboxFailureFacts>) =>
  classifyOutboxFailure({
    sqlState: null,
    errorClass: 'unknown',
    responseReceived: false,
    ...facts,
  })

describe('hosted record outbox failure classification', () => {
  test.each([
    ['row-level security', { sqlState: '42501', responseReceived: true }],
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
  ] satisfies Array<[string, Partial<OutboxFailureFacts>]>)('%s is pass-fatal', (_name, facts) => {
    expect(classify(facts)).toBe('pass-fatal')
  })
})
