// concern: architecture-manifest
/** Ratchet module allowlists shared by the gate and orchestrator. */

export const ratchetModules = [
  {
    file: 'orchestrator/src/commands/ratchet.ts',
    allowed: ['commander', '../ratchet/ratchet-service.ts'],
  },
  {
    file: 'orchestrator/src/ratchet/ratchet-service.ts',
    allowed: [
      'node:fs',
      'node:os',
      'node:path',
      '../../../shared/change-view.ts',
      '../../../shared/git.ts',
      '../../../shared/ratchet.ts',
      '../project/projects.ts',
      './biome-adapter.ts',
      './ratchet-plan.ts',
    ],
  },
  {
    file: 'orchestrator/src/ratchet/biome-adapter.ts',
    allowed: ['../../../shared/ratchet.ts'],
  },
  {
    file: 'orchestrator/src/ratchet/biome-adapter.test.ts',
    allowed: ['bun:test', './biome-adapter.ts'],
  },
  {
    file: 'orchestrator/src/ratchet/ratchet-plan.ts',
    allowed: ['../../../shared/change-view.ts'],
  },
  {
    file: 'orchestrator/src/ratchet/ratchet-plan.test.ts',
    allowed: ['bun:test', '../../../shared/change-view.ts', './ratchet-plan.ts'],
  },
] as const
