type SetupModuleSpec = {
  name: string
  file: string
  allowed: readonly string[]
  typeOnlyAllowed: readonly string[]
  reason: string
}

export const setupModuleSpecs: readonly SetupModuleSpec[] = [
  {
    name: 'setup-repository-facts-boundary',
    file: 'orchestrator/src/setup/repository-facts.ts',
    allowed: [
      'node:fs',
      'node:path',
      '../../../shared/git.ts',
      '../project/projects.ts',
      './repository-toolchain.ts',
    ],
    typeOnlyAllowed: ['./setup-toolchain.ts'],
    reason: 'Keep repository detection independent of stores, setup policy, and CLI grammar.',
  },
  {
    name: 'setup-engine-boundary',
    file: 'orchestrator/src/setup/setup-engine.ts',
    allowed: ['../../../shared/brand.ts', './setup-mcp.ts', './setup-toolchain.ts'],
    typeOnlyAllowed: ['../project/projects.ts', './repository-facts.ts', './setup-facts.ts'],
    reason:
      'Keep setup proposals pure and independent of stores, filesystems, commands, and processes.',
  },
  {
    name: 'setup-planner-boundary',
    file: 'orchestrator/src/setup/setup-planner.ts',
    allowed: ['./setup-toolchain.ts'],
    typeOnlyAllowed: [
      '../project/projects.ts',
      './setup-engine.ts',
      './setup-facts.ts',
      './setup-mcp.ts',
    ],
    reason: 'Keep setup action planning pure and independent of stores, adapters, and commands.',
  },
  {
    name: 'setup-apply-boundary',
    file: 'orchestrator/src/setup/setup-apply.ts',
    allowed: ['node:fs/promises', 'node:path', './setup-mcp.ts'],
    typeOnlyAllowed: ['./setup-planner.ts'],
    reason:
      'Keep ordered application independent of project service implementation and CLI grammar.',
  },
  {
    name: 'setup-repository-toolchain-boundary',
    file: 'orchestrator/src/setup/repository-toolchain.ts',
    allowed: [
      'node:fs',
      'node:path',
      'package-manager-detector',
      '../worktree/worktree-lifecycle.ts',
      './setup-toolchain.ts',
    ],
    typeOnlyAllowed: [],
    reason: 'Keep manifest detection independent of setup policy, stores, commands, and processes.',
  },
  {
    name: 'setup-toolchain-boundary',
    file: 'orchestrator/src/setup/setup-toolchain.ts',
    allowed: ['../../../shared/brand.ts', '../recipe/recipe-schema.ts'],
    typeOnlyAllowed: [],
    reason: 'Keep gate and recipe proposals pure and independent of adapters and persistence.',
  },
  {
    name: 'setup-mcp-boundary',
    file: 'orchestrator/src/setup/setup-mcp.ts',
    allowed: ['../../../shared/secret-shaped.ts'],
    typeOnlyAllowed: [],
    reason: 'Keep harness MCP CLI grammar independent of setup policy, stores, and projects.',
  },
]
