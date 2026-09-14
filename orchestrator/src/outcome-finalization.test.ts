import { describe, expect, test } from 'bun:test'
import { workerReply as fixtureWorkerReply } from '../test/fixtures/replies.ts'
import type { WorkerReply } from './contract.ts'
import { FAILS_OVER } from './failure.ts'
import { finalizeWorkerReply } from './outcome.ts'

const classify = (reply: WorkerReply, measuredFiles: string[] | null = ['changed']) =>
  finalizeWorkerReply({ reply, measuredFiles, status: reply.status === 'asking' ? 'asking' : 'ok',
    failureKind: null, error: null })
const reply = (overrides: Record<string, unknown>): WorkerReply => fixtureWorkerReply(overrides) as WorkerReply

describe('worker reply finalization', () => {
  test('run 1743 placeholder shape is a visible contract failure with no question', () => {
    const result = classify(reply({ status: 'asking', questions: [{ question: 'placeholder', options: null, recommendation: null, why: null }] }))
    expect(result).toMatchObject({ status: 'failed', failureKind: 'contract', acceptedQuestions: [] })
    expect(result.error).toContain('rejected question text: "placeholder"')
  })
  test('asking with text but empty why is a contract failure', () => {
    expect(classify(reply({ status: 'asking', questions: [{ question: 'one table or two?', options: null, recommendation: null, why: ' ' }] }))).toMatchObject({ status: 'failed', failureKind: 'contract' })
  })
  test('format-only why is a contract failure', () => {
    for (const why of ['\u200B', '\u2060', '\u00AD', '\u200B\u2060']) expect(classify(reply({ status: 'asking', questions: [{ question: 'one table or two?', options: null, recommendation: null, why }] }))).toMatchObject({ status: 'failed', failureKind: 'contract', acceptedQuestions: [] })
  })
  test('punctuated generic and invisible-only questions fail in the run path', () => {
    for (const question of ['(placeholder)!', '\u200B\u2060']) expect(classify(reply({ status: 'asking', questions: [{ question, options: null, recommendation: null, why: 'a claimed reason' }] }))).toMatchObject({ status: 'failed', failureKind: 'contract', acceptedQuestions: [] })
  })
  test('a real question and why are accepted and recorded as before', () => {
    const result = classify(reply({ status: 'asking', questions: [{ question: 'one table or two?', options: ['one', 'two'], recommendation: 'two', why: 'the choice changes the public query shape' }] }))
    expect(result.status).toBe('asking')
    expect(result.acceptedQuestions.map(({ question, why }) => ({ question, why }))).toEqual([{ question: 'one table or two?', why: 'the choice changes the public query shape' }])
  })
  test('a real question beside a blank is accepted and only the real one is recorded', () => {
    const result = classify(reply({ status: 'asking', questions: [{ question: 'which table?', options: null, recommendation: null, why: 'the schema changes' }, { question: '   ', options: null, recommendation: null, why: 'unknown choice' }] }))
    expect(result.status).toBe('asking')
    expect(result.acceptedQuestions.map(({ question, why }) => ({ question, why }))).toEqual([{ question: 'which table?', why: 'the schema changes' }])
    expect(result.error).toBe('1 invalid question dropped; rejected question text: "   "')
  })
  test('done carrying a real question is reclassified as asking', () => {
    const result = classify(reply({ status: 'done', questions: [{ question: 'Which table?', options: null, recommendation: null, why: 'the schema changes' }] }))
    expect(result).toMatchObject({ status: 'asking', failureKind: null })
    expect(result.error).toBe('status reclassified from done to asking: a worker with a real question has not finished')
  })
  test('done carrying two real questions records both and remains asking', () => {
    const result = classify(reply({ status: 'done', questions: [{ question: 'Which table?', options: null, recommendation: null, why: 'the schema changes' }, { question: 'Which index?', options: null, recommendation: null, why: 'the query changes' }] }))
    expect(result.status).toBe('asking')
    expect(result.acceptedQuestions.map(({ question }) => ({ question }))).toEqual([{ question: 'Which table?' }, { question: 'Which index?' }])
  })
  test('done carrying one real and one blank question records only the real one', () => {
    const result = classify(reply({ status: 'done', questions: [{ question: 'Which table?', options: null, recommendation: null, why: 'the schema changes' }, { question: ' ', options: null, recommendation: null, why: 'unknown choice' }] }))
    expect(result.status).toBe('asking')
    expect(result.acceptedQuestions.map(({ question }) => ({ question }))).toEqual([{ question: 'Which table?' }])
    expect(result.error).toBe('status reclassified from done to asking: a worker with a real question has not finished\n1 invalid question dropped; rejected question text: " "')
  })
  test('done carrying only blank questions stays done and records the dropped blanks', () => {
    const result = classify(reply({ status: 'done', questions: [{ question: ' ', options: null, recommendation: null, why: 'unknown choice' }, { question: '\u200B', options: null, recommendation: null, why: '\u2060' }] }))
    expect(result.status).toBe('ok')
    expect(result.error).toBe('2 invalid questions dropped; rejected question text: " ", "​"')
    expect(result.acceptedQuestions).toEqual([])
  })
  test('done carrying no questions remains done', () => {
    expect(classify(reply({ status: 'done', questions: null }))).toMatchObject({ status: 'ok', error: null, acceptedQuestions: [] })
  })
  test('an all-blank asking reply remains a failover-eligible contract failure', () => {
    const result = classify(reply({ status: 'asking', questions: [{ question: ' ', options: null, recommendation: null, why: 'unknown choice' }, { question: '\u200B', options: null, recommendation: null, why: '\u2060' }] }))
    expect(result).toMatchObject({ status: 'failed', failureKind: 'contract', acceptedQuestions: [] })
    expect(FAILS_OVER).toContain('contract')
  })
})
