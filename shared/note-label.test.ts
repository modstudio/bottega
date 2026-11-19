import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from './brand.ts'
import { formatNoteLabel, parseNoteLabel } from './note-label.ts'

const project = PLATFORM_NAME.toLowerCase()

describe('note label', () => {
  test('round trips a project and positive number', () => {
    expect(parseNoteLabel(formatNoteLabel(project, 575))).toEqual({
      project,
      number: 575,
    })
    expect(parseNoteLabel('workshop#n41')).toEqual({ project: 'workshop', number: 41 })
  })

  test.each(['575', '#575', `${project}#0`, `${project}#-1`])('refuses %s', (value) => {
    expect(() => parseNoteLabel(value)).toThrow(
      `reference ${JSON.stringify(value)} is malformed; pass <project>#<number> or <project>#n<number>`,
    )
  })
})
