// concern: branch prune remedy
/** Names the action that clears a branch kept by the prune classifier. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

/** Return the operator remedy for one prune refusal. */
export function branchVerdictRemedy(
  reason: 'throwaway' | 'superseded' | 'unlanded' | 'unknown',
  project: string,
  branch: string,
  key: string | null,
): string {
  if (reason === 'throwaway')
    return `${PLATFORM_SLUG} tree branch dispose ${project}:${branch} --reason throwaway --note "<why>"`
  if (reason === 'superseded')
    return `${PLATFORM_SLUG} tree branch dispose ${project}:${branch} --reason superseded --note "superseded by <branch>"`
  if (reason === 'unlanded')
    return `land it through its own pull request, or ${PLATFORM_SLUG} tree branch dispose ${project}:${branch} --reason abandoned --note "<why>"`
  return `${PLATFORM_SLUG} tree branch prune --project ${project} --key ${key ?? '<KEY>'} --dry-run once the reported error clears`
}
