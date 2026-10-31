// concern: question-display
/** Run-question text reaches displays only through renderRunQuestionText or displayRunQuestion. */

import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type QuestionScratchLocation = 'scratch' | 'artifacts' | 'gone' | 'unknown'

export type QuestionDisplayPaths = {
  scratch: string
  artifacts: string
  droppedManifest: string
}

const PATH_SEGMENT = '[A-Za-z0-9._-]*[A-Za-z0-9_-]'
const RELATIVE_PATH = `${PATH_SEGMENT}(?:/${PATH_SEGMENT})*`

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function referencePattern(scratchDirectory: string): RegExp {
  return new RegExp(
    `(?:${escapeRegExp(scratchDirectory)}|\\$BOTTEGA_SCRATCH)/(${RELATIVE_PATH})`,
    'g',
  )
}

function isScratchRelative(path: string): boolean {
  return path.split('/').every((part) => part !== '.' && part !== '..')
}

export function referencedQuestionScratchPaths(text: string, scratchDirectory: string): string[] {
  const paths = new Set<string>()
  for (const match of text.matchAll(referencePattern(scratchDirectory))) {
    const path = match[1]
    if (path && isScratchRelative(path)) paths.add(path)
  }
  return [...paths]
}

export function renderRunQuestionText(
  text: string,
  paths: QuestionDisplayPaths,
  locations: ReadonlyMap<string, QuestionScratchLocation>,
): string {
  return text.replace(referencePattern(paths.scratch), (reference, relativePath: string) => {
    const location = locations.get(relativePath)
    if (!location || location === 'unknown') return reference
    if (location === 'scratch') {
      return reference.startsWith('$BOTTEGA_SCRATCH/')
        ? join(paths.scratch, relativePath)
        : reference
    }
    if (location === 'artifacts') return join(paths.artifacts, relativePath)
    return `${reference} (not retained at turn end; see ${paths.droppedManifest})`
  })
}

export function runQuestionGroupFooter(rootId: string, questionNumbers: number[]): string {
  if (questionNumbers.length === 1) {
    return `rule on it:  ${PLATFORM_SLUG} question answer ${rootId} "<ruling>"`
  }
  const rulings = questionNumbers.map((number) => `--q${number} "<ruling>"`).join(' ')
  return `rule on them in ONE command:  ${PLATFORM_SLUG} question answer ${rootId} ${rulings}`
}
