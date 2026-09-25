import type { ImportBoundary } from './architecture-boundaries.ts'

const source = 'orchestrator/src/settings/'

export const settingsBoundarySpecs: ImportBoundary[] = [
  {
    name: 'settings-boundary',
    file: `${source}settings.ts`,
    allowed: ['zod'],
    typeOnlyAllowed: [],
    reason: 'Keep owned settings schema and extraction pure.',
  },
  {
    name: 'settings-render-boundary',
    file: `${source}settings-render.ts`,
    allowed: ['node:crypto', `${source}settings.ts`],
    typeOnlyAllowed: [],
    reason: 'Keep settings file render and drift pure.',
  },
  {
    name: 'settings-lint-boundary',
    file: `${source}settings-lint.ts`,
    allowed: ['shared/ratchet.ts', `${source}settings.ts`],
    typeOnlyAllowed: [],
    reason: 'Keep settings lint decisions pure.',
  },
  {
    name: 'settings-files-boundary',
    file: `${source}settings-files.ts`,
    allowed: ['node:fs', 'node:path', `${source}settings.ts`, `${source}settings-render.ts`],
    typeOnlyAllowed: [],
    reason: 'Keep settings file access independent of stores, commands, and transports.',
  },
  {
    name: 'settings-commands-boundary',
    file: `${source}settings-commands.ts`,
    allowed: [
      'shared/ratchet.ts',
      'orchestrator/src/doc/docs.ts',
      'orchestrator/src/project/projects.ts',
      `${source}settings.ts`,
      `${source}settings-files.ts`,
      `${source}settings-lint.ts`,
      `${source}settings-render.ts`,
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep settings commands independent of runs, routing, transports, the CLI, and worktrees.',
  },
]
