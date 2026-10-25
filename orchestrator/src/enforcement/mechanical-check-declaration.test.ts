import { describe, expect, test } from 'bun:test'
import { mechanicalCheckEntryIssues } from './mechanical-check-declaration.ts'

const messages = (identifier: string, entry: unknown, mode: 'strict' | 'strip' = 'strict') =>
  mechanicalCheckEntryIssues(identifier, entry, mode).map(({ path, message }) => ({
    path,
    message,
  }))

/** A declaration a newer binary wrote: a category and a field this one has not heard of. */
const unknownCategory = ['mystery', { tool: 'probe' }] as const
const unknownField = ['spelling', { tool: 'typos', newField: 1 }] as const

describe('mechanicalCheckEntryIssues', () => {
  test('refuses malformed declarations with their field paths and messages', () => {
    expect(messages('mystery', { tool: 'probe' })).toEqual([
      expect.objectContaining({
        path: ['mystery'],
        message: expect.stringContaining('unknown category'),
      }),
    ])
    expect(messages('naming', { optOut: { reason: ' ' } })).toEqual([
      {
        path: ['naming', 'optOut'],
        message: 'optOut must contain only a non-empty reason',
      },
    ])
    expect(messages('spelling', { optOut: { reason: 'not used' }, tool: 'probe' })).toEqual([
      {
        path: ['spelling'],
        message: 'optOut cannot be mixed with override fields: tool',
      },
    ])
    expect(messages('formatting', {})).toEqual([
      {
        path: ['formatting'],
        message: 'empty override; set at least one of tool, points, blocking, limit, note',
      },
    ])
    expect(messages('import-boundaries', { points: ['write'] })).toEqual([
      {
        path: ['import-boundaries', 'points'],
        message: 'project-scope points cannot include write or commit',
      },
    ])
    expect(messages('type-errors', { points: ['commit'] })).toEqual([
      {
        path: ['type-errors', 'points'],
        message: 'project-scope points cannot include write or commit',
      },
    ])
    expect(messages('file-placement', { limit: 10 })).toEqual([
      {
        path: ['file-placement', 'limit'],
        message: 'file-placement has no limit; remove the limit field',
      },
    ])
    expect(messages('secrets', { points: ['gate', 'gate'] })).toEqual([
      {
        path: ['secrets', 'points'],
        message: 'points must not contain duplicates',
      },
    ])
  })

  test('a register read drops a category or a field this binary does not know', () => {
    expect(messages(...unknownCategory, 'strip')).toEqual([])
    expect(messages(...unknownField, 'strip')).toEqual([])
    // The write keeps the refusal it always made, so a typo in a declaration
    // is still caught at the register edge.
    expect(messages(...unknownCategory)).toEqual([
      {
        path: ['mystery'],
        message: expect.stringContaining('unknown category'),
      },
    ])
    expect(messages(...unknownField)).toEqual([
      {
        path: ['spelling'],
        message: expect.stringContaining('entry has unknown fields: newField'),
      },
    ])
  })

  test('a check on a category or a field this binary knows is the same in either mode', () => {
    expect(messages('file-placement', { limit: 10 }, 'strip')).toEqual([
      {
        path: ['file-placement', 'limit'],
        message: 'file-placement has no limit; remove the limit field',
      },
    ])
  })

  test('accepts every override field and the commit-message commit point', () => {
    expect(
      messages('function-length', {
        tool: 'custom lint',
        points: ['write', 'commit'],
        blocking: false,
        limit: 60,
        note: 'generated files excluded',
      }),
    ).toEqual([])
    expect(messages('commit-message', { points: ['commit'] })).toEqual([])
  })
})
