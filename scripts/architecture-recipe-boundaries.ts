import { dirname, normalize } from 'node:path'
import type { ImportBoundary } from './architecture-boundaries.ts'

const boundary = (
  name: string,
  file: string,
  allowed: string[],
  reason: string,
): ImportBoundary => ({
  name,
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
  typeOnlyAllowed: [],
  reason,
})

export const recipeBoundarySpecs: ImportBoundary[] = [
  boundary(
    'recipe-lifecycle-boundary',
    'orchestrator/src/recipe/recipe-lifecycle.ts',
    [
      './compose-provision-plan.ts',
      './recipe-schema.ts',
      './recipe-step.ts',
      '../resources/docker-executable.ts',
    ],
    'Keep lifecycle planning pure and independent of execution, persistence, filesystem, and the register.',
  ),
  boundary(
    'recipe-loader-boundary',
    'orchestrator/src/recipe/recipe-loader.ts',
    ['node:fs', 'node:path', '../git/git-environment.ts', './recipe-schema.ts'],
    'Keep tracked recipe loading independent of execution, persistence, and CLI concerns.',
  ),
  boundary(
    'recipe-schema-boundary',
    'orchestrator/src/recipe/recipe-schema.ts',
    [
      'zod',
      './database-provision-schema.ts',
      './recipe-exec-schema.ts',
      '../worktree/provision-group-validation.ts',
    ],
    'Keep the recipe schema pure and independent of file, register, and execution concerns.',
  ),
  boundary(
    'recipe-step-boundary',
    'orchestrator/src/recipe/recipe-step.ts',
    [
      'node:path',
      '../worktree/worktree-template.ts',
      './recipe-schema.ts',
      '../resources/docker-executable.ts',
    ],
    'Keep recipe step execution independent of lifecycle, persistence, claims, and register concerns.',
  ),
]
