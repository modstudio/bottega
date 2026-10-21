export const worktreeBoundarySpecs = [
  {
    name: 'worktree-attribution-boundary',
    file: 'orchestrator/src/worktree/worktree-attribution.ts',
    allowed: [
      'node:fs',
      'node:path',
      '../filesystem-identity-plan.ts',
      '../../../shared/record-id.ts',
      '../git/checkout-identity.ts',
      '../database/database-location.ts',
      '../database/db.ts',
      '../git/git-environment.ts',
      './worktree-types.ts',
    ],
    typeOnlyAllowed: ['./worktree.ts'],
    reason: 'Keep attribution and extraction independent of lifecycle policy and transports.',
  },
  {
    name: 'worktree-mcp-boundary',
    file: 'orchestrator/src/worktree/worktree-mcp.ts',
    allowed: ['node:fs', 'node:path'],
    typeOnlyAllowed: [],
    reason: 'Keep worker MCP file provisioning independent of lifecycle and policy.',
  },
  {
    name: 'worktree-template-boundary',
    file: 'orchestrator/src/worktree/worktree-template.ts',
    allowed: [],
    typeOnlyAllowed: [],
    reason: 'Keep template grammar independent of execution, lifecycle, and policy.',
  },
]
