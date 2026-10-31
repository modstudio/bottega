// concern: question-display
/** This is the only renderer of run-question text for display. */

import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type QuestionScratchLocation = 'scratch' | 'artifacts' | 'gone'

const PATH_SEGMENT = '[A-Za-z0-9._-]*[A-Za-z0-9_-]'
const RELATIVE_PATH = `${PATH_SEGMENT}(?:/${PATH_SEGMENT})*`

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function referencePattern(runDirectory: string): RegExp {
  return new RegExp(
    `(?:${escapeRegExp(join(runDirectory, 'scratch'))}|\\$BOTTEGA_SCRATCH)/(${RELATIVE_PATH})`,
    'g',
  )
}

function isScratchRelative(path: string): boolean {
  return path.split('/').every((part) => part !== '.' && part !== '..')
}

export function referencedQuestionScratchPaths(text: string, runDirectory: string): string[] {
  const paths = new Set<string>()
  for (const match of text.matchAll(referencePattern(runDirectory))) {
    const path = match[1]
    if (path && isScratchRelative(path)) paths.add(path)
  }
  return [...paths]
}

export function renderRunQuestionText(
  text: string,
  runDirectory: string,
  locations: ReadonlyMap<string, QuestionScratchLocation>,
): string {
  return text.replace(referencePattern(runDirectory), (reference, relativePath: string) => {
    const location = locations.get(relativePath)
    if (!location || location === 'scratch') return reference
    if (location === 'artifacts') return join(runDirectory, 'artifacts', relativePath)
    return (
      `${reference} (not retained at turn end; see ` +
      `${join(runDirectory, 'artifacts', 'dropped.json')})`
    )
  })
}

export function runQuestionGroupFooter(rootId: string, questionNumbers: number[]): string {
  if (questionNumbers.length === 1) {
    return `rule on it:  ${PLATFORM_SLUG} question answer ${rootId} "<ruling>"`
  }
  const rulings = questionNumbers.map((number) => `--q${number} "<ruling>"`).join(' ')
  return `rule on them in ONE command:  ${PLATFORM_SLUG} question answer ${rootId} ${rulings}`
}
