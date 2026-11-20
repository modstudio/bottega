import { TREE_RUN_SCRIPTS } from '../shared/tree-run-scripts.ts'

type ExactArchitecturePath = (target: string) => string

export function treeRunScriptArchitectureRule(exactPath: ExactArchitecturePath) {
  return {
    name: 'tree-run-scripts-reach-no-orchestrator-store',
    severity: 'error' as const,
    comment: "Scripts run from a disposable tree must not open the tree binary's local store.",
    from: { path: TREE_RUN_SCRIPTS.map(exactPath).join('|') },
    to: {
      path: [
        'orchestrator/src/project/projects.ts',
        'orchestrator/src/project/project-read.ts',
        'orchestrator/src/database/db.ts',
      ]
        .map(exactPath)
        .join('|'),
      reachable: true,
    },
  }
}
