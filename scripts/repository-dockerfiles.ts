import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { startBoundedSync } from '../shared/bounded-process.ts'
import { inspectionGitEnv } from '../shared/git.ts'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'

function isDockerfile(path: string): boolean {
  const name = path.split('/').at(-1) ?? ''
  return name === 'Dockerfile' || name.endsWith('.Dockerfile')
}

/** Tracked and untracked, unignored Dockerfiles, so a worker's new image is judged before commit. */
export function repositoryDockerfiles(root: string): string[] {
  const result = startBoundedSync(
    ['git', ...nulPathListArgs(['ls-files', '--cached', '--others', '--exclude-standard'])],
    { budget: 'git-plumbing', cwd: root, env: inspectionGitEnv() },
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `could not list the repository's Dockerfiles: ${result.stderr.toString().trim() || `git exited ${result.exitCode}`}; run git ls-files from the repository root`,
    )
  }
  // A tracked file deleted in the working tree builds no image.
  return splitNulPaths(result.stdout.toString())
    .filter((path) => isDockerfile(path) && existsSync(resolve(root, path)))
    .sort()
}
