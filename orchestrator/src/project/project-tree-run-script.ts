// concern: project-tree-run-script
/** Keeps Bottega's workflow-owned tree scripts inside the architecture guard. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { TREE_RUN_SCRIPTS, TREE_RUN_SCRIPTS_MODULE } from '../../../shared/tree-run-scripts.ts'

type BeforePullRequestSettings = {
  beforePullRequest?: readonly { run: string }[]
}

function scriptsFiles(command: string): string[] {
  return [...command.matchAll(/(?:^|\s)["']?(scripts\/[^\s"']+)["']?(?=\s|$)/g)].map(
    (match) => match[1]!,
  )
}

export function treeRunScriptProblems(
  projectName: string | undefined,
  release: BeforePullRequestSettings | undefined,
): string[] {
  if (projectName !== PLATFORM_SLUG) return []
  const listed = new Set<string>(TREE_RUN_SCRIPTS)
  return (release?.beforePullRequest ?? []).flatMap((entry, index) =>
    scriptsFiles(entry.run)
      .filter((file) => !listed.has(file))
      .map(
        (file) =>
          `release.beforePullRequest.${index}.run executes unlisted tree script ${file}; add it to ${TREE_RUN_SCRIPTS_MODULE}`,
      ),
  )
}
