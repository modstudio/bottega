// concern: workflow-floor-pull-request-evidence
/** Resolves and binds a pull-request artifact to a cursor branch and project. */

import type { Database } from 'bun:sqlite'
import { githubRepository } from '../../../shared/github-repository.ts'
import { viewPullRequest } from '../branch/merged-pull-request.ts'
import { projectByName } from '../project/projects.ts'
import type { ValidatedArtifactEvidence } from './workflow-artifact-evidence.ts'
import { gitText } from './workflow-floor-evidence-checkout.ts'
import {
  type FloorEvidencePorts,
  invokeFloorEvidencePort,
} from './workflow-floor-evidence-replay.ts'

export function gatherPullRequestArtifactEvidence(
  reference: string,
  identity: { project: string; branch: string | null },
  d: Database,
  ports: FloorEvidencePorts,
  flag = `--artifact ${reference}`,
): NonNullable<ValidatedArtifactEvidence['pullRequest']> {
  const project = projectByName(identity.project, d)
  if (!project) throw new Error(`project ${identity.project} is not registered`)
  const trunk = project.settings.trunk?.trim()
  if (!identity.branch || !trunk)
    throw new Error(
      `${flag} cannot be checked because this cursor has no branch or its project has no trunk`,
    )
  const fallback = (projectName: string, value: number | string) => {
    const row = projectByName(projectName)
    if (!row)
      throw new Error(`project ${projectName} is not registered; cannot view pull request ${value}`)
    return viewPullRequest(row, value)
  }
  const number = /^#([1-9][0-9]*)$/.exec(reference)?.[1]
  const view = invokeFloorEvidencePort(
    ports,
    'viewPullRequest',
    fallback,
    identity.project,
    number ? Number(number) : reference,
  )
  const resolvedNumber = /\/pull\/([1-9][0-9]*)\/?$/i.exec(view.url)?.[1]
  if (
    (number && resolvedNumber !== number) ||
    (!number && view.url.replace(/\/$/, '') !== reference.replace(/\/$/, ''))
  )
    throw new Error(`${flag} resolved as ${view.url}, not the supplied pull-request link`)
  const originUrl = invokeFloorEvidencePort(
    ports,
    'readOriginUrl',
    () => gitText(project.path, ['remote', 'get-url', 'origin']),
    identity.project,
  )
  return {
    url: view.url,
    repository: githubRepository(view.url.replace(/\/pull\/\d+\/?$/i, '')),
    projectRepository: githubRepository(originUrl),
    state: view.state,
    head: view.headRefName,
    base: view.baseRefName,
    cursorBranch: identity.branch,
    trunk,
  }
}
