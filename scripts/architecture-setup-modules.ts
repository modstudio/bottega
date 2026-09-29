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
    allowed: ['node:fs', 'node:path', '../../../shared/git.ts', '../project/projects.ts'],
    typeOnlyAllowed: [],
    reason: 'Keep repository detection independent of stores, setup policy, and CLI grammar.',
  },
  {
    name: 'setup-engine-boundary',
    file: 'orchestrator/src/setup/setup-engine.ts',
    allowed: ['../../../shared/brand.ts', './setup-mcp.ts'],
    typeOnlyAllowed: ['../project/projects.ts', './repository-facts.ts', './setup-facts.ts'],
    reason:
      'Keep setup proposals pure and independent of stores, filesystems, commands, and processes.',
  },
  {
    name: 'setup-planner-boundary',
    file: 'orchestrator/src/setup/setup-planner.ts',
    allowed: [],
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
    allowed: ['./setup-mcp.ts'],
    typeOnlyAllowed: ['./setup-planner.ts'],
    reason:
      'Keep ordered application independent of project service implementation and CLI grammar.',
  },
  {
    name: 'setup-mcp-boundary',
    file: 'orchestrator/src/setup/setup-mcp.ts',
    allowed: ['../../../shared/secret-shaped.ts'],
    typeOnlyAllowed: [],
    reason: 'Keep harness MCP CLI grammar independent of setup policy, stores, and projects.',
  },
]
