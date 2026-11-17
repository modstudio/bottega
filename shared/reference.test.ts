import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { newRecordId } from './record-id.ts'
import { parseReference } from './reference.ts'

describe('record reference grammar', () => {
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
})
