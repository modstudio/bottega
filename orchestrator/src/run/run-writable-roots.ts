import { workerSharedGitObjectsRoot, workerSharedGitRoots } from '../resources/ref-guard.ts'

/** Select shared Git writes without granting readers any ref directory. */
export function repositoryWorkerSharedGitRoots(
  cwd: string,
  branch: string,
  writesRepo: boolean,
): string[] {
  return writesRepo ? workerSharedGitRoots(cwd, branch) : [workerSharedGitObjectsRoot(cwd)]
}
