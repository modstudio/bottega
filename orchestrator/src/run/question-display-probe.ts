// concern: question-display-probe
/** Resolves run-question scratch references against locally available run artifacts. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DROPPED_ARTIFACTS_MANIFEST, runArtifactsDir, runScratchDir } from '../artifact-paths.ts'
import { resolveRunsDirectory } from '../database/database-location.ts'
import {
  type QuestionScratchLocation,
  referencedQuestionScratchPaths,
  renderRunQuestionText,
} from './question-display.ts'

export function displayRunQuestion(runRecordId: string, text: string): string {
  const runsDirectory = resolveRunsDirectory(process.env)
  const scratch = runScratchDir(runRecordId, runsDirectory)
  const artifacts = runArtifactsDir(runRecordId, runsDirectory)
  const locations = new Map<string, QuestionScratchLocation>()
  for (const relativePath of referencedQuestionScratchPaths(text, scratch)) {
    const location: QuestionScratchLocation = existsSync(join(scratch, relativePath))
      ? 'scratch'
      : existsSync(join(artifacts, relativePath))
        ? 'artifacts'
        : !existsSync(scratch) && existsSync(artifacts)
          ? 'gone'
          : 'unknown'
    locations.set(relativePath, location)
  }
  return renderRunQuestionText(
    text,
    {
      scratch,
      artifacts,
      droppedManifest: join(artifacts, DROPPED_ARTIFACTS_MANIFEST),
    },
    locations,
  )
}
