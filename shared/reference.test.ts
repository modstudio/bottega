import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { newRecordId } from './record-id.ts'
import { formatReference, parsePointerReference, parseReference } from './reference.ts'
import {
  malformedReferenceRefusal,
  POINTER_REFERENCE_FORMS,
  referenceNotVisibleRefusal,
  referenceStoreUnreachableRefusal,
} from './reference-refusal.ts'

describe('record reference grammar', () => {
  test.each([
    ['question', 42],
    ['run', 73],
    ['note', 9],
  ] as const)('formats and parses a %s reference', (kind, number) => {
    expect(parseReference(formatReference(kind, number)).value).toEqual({
      kind: 'label',
      prefix: kind === 'question' ? 'q' : kind === 'run' ? 'r' : 'n',
      number,
    })
  })
  test('accepts every reference form', () => {
    const id = newRecordId()
    expect(parseReference(id).value).toEqual({ kind: 'record-id', recordId: id })
    expect(parseReference('q42').value).toEqual({ kind: 'label', prefix: 'q', number: 42 })
    expect(parseReference('DEV-2378').value).toEqual({ kind: 'task-key', key: 'DEV-2378' })
    expect(parseReference(`${PLATFORM_SLUG}#q42`).qualifier).toEqual({
      kind: 'project',
      value: PLATFORM_SLUG,
    })
    expect(parseReference('workstation/r42').qualifier).toEqual({
      kind: 'machine',
      value: 'workstation',
    })
    expect(parseReference('42', 'run').value).toEqual({
      kind: 'number',
      number: 42,
      referenceKind: 'run',
    })
  })

  test.each(['', ' q1', 'q0', 'q-1', '#q1', `${PLATFORM_SLUG}#`, 'a/b#q1', 'DEV-0', 'Q1'])(
    'refuses malformed reference %p',
    (value) => expect(() => parseReference(value)).toThrow('invalid reference'),
  )

  test('refuses a bare number without a kind', () => {
    expect(() => parseReference('42')).toThrow('a bare number requires a kind')
  })

  test.each([
    ['doc:project/workshop/identity', 'doc'],
    [`doc:${newRecordId()}`, 'doc'],
    ['task:DEV-2473', 'task'],
    ['task:DEV-2473#comment:4', 'comment'],
    ['DEV-2473/6', 'task-document'],
    ['#42', 'pull-request'],
    ['https://github.com/acme/app/pull/42', 'pull-request'],
    ['1234567', 'run'],
    ['007', 'run'],
    ['r42', 'run'],
    ['1234567890123456789012345678901234567890', 'commit'],
    ['abc1234', 'commit'],
    [`probe:${newRecordId()}`, 'probe'],
    [`exec:${newRecordId()}`, 'exec'],
    [`review-read:${newRecordId()}`, 'review-read'],
    [`attached-text:${newRecordId()}`, 'attached-text'],
  ] as const)('parses pointer and evidence form %s', (value, kind) => {
    expect(parsePointerReference(value).kind).toBe(kind)
  })

  test.each(['doc:bad', 'task:nope', '#0', '123abc', 'abcdef', 'probe:bad'])(
    'refuses malformed pointer form %s with the accepted forms',
    (value) => expect(() => parsePointerReference(value)).toThrow(POINTER_REFERENCE_FORMS),
  )

  test('keeps malformed, not-visible, and unreachable refusals distinct', () => {
    const refusals = [
      malformedReferenceRefusal('bad'),
      referenceNotVisibleRefusal('project workshop', 'pass the UUID'),
      referenceStoreUnreachableRefusal('doc store'),
    ]
    expect(new Set(refusals).size).toBe(3)
    expect(refusals[0]).toContain(POINTER_REFERENCE_FORMS)
    expect(refusals[1]).toContain('not visible')
    expect(refusals[2]).toContain('could not reach')
  })
})
