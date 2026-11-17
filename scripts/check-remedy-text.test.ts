import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { remedyCommandCitationFindings } from './check-remedy-text.ts'

const known = [
  'project',
  'project list',
  'question',
  'question ruling',
  'question ruling list',
  'task',
] as const

test('classifies command citations against the complete registered path', () => {
  expect(remedyCommandCitationFindings('run ${PLATFORM_SLUG} project show alpha', known)).toEqual(
    [`${PLATFORM_SLUG} project show`],
  )
  expect(
    remedyCommandCitationFindings(
      'run \\`${PLATFORM_SLUG} ruling list --changed-after\\`',
      known,
    ),
  ).toEqual([`${PLATFORM_SLUG} ruling`])
  expect(
    remedyCommandCitationFindings('${PLATFORM_SLUG} question ruling lst --json', known),
  ).toEqual([`${PLATFORM_SLUG} question ruling lst`])
})

test('skips prose and allowlisted non-command phrases while accepting a registered command', () => {
  expect(remedyCommandCitationFindings('${PLATFORM_SLUG} binary is unavailable', known)).toEqual([])
  expect(remedyCommandCitationFindings('${PLATFORM_SLUG} task client refuses', known)).toEqual([])
  expect(
    remedyCommandCitationFindings(
      'run \\`${PLATFORM_SLUG} question ruling list --changed-after\\`',
      known,
    ),
  ).toEqual([])
})
