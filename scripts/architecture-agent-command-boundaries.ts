export const agentCommandBoundarySpecs = [
  {
    name: 'agent-commands-boundary',
    file: 'orchestrator/src/agent/agent-commands.ts',
    allowed: [
      '../../../shared/brand.ts',
      './agent-probe.ts',
      './agent-registry.ts',
      '../cli/args.ts',
      '../database/db.ts',
      './model-host.ts',
      './agent-set-capacity.ts',
      './agent-share.ts',
      './goose-provider.ts',
    ],
    reason:
      'Keep agent registry command adapters independent of the run nucleus and the CLI: they compose concern modules for one verb and own no lifecycle.',
  },
]
