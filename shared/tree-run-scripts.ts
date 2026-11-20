/** Scripts in this repository that project workflows may run from a disposable tree. */
export const TREE_RUN_SCRIPTS = [
  'scripts/record-rehearse.ts',
  'scripts/test-focused.ts',
  'scripts/check-typecheck-reach.ts',
  'hub/scripts/test-postgres-evidence.ts',
] as const

export const TREE_RUN_SCRIPTS_MODULE = 'shared/tree-run-scripts.ts'
