export const docBoundarySpecs = [
  {
    name: 'doc-commands-boundary',
    file: 'orchestrator/src/doc/doc-commands.ts',
    allowed: [
      '../../../shared/brand.ts',
      'node:fs',
      '../../../shared/docs.ts',
      '../canon/canon-files.ts',
      '../canon/canon.ts',
      '../database/db.ts',
      '../record/record-session.ts',
      '../worker-store-write.ts',
      './doc-write-tree.ts',
      './doc-search-service.ts',
      './doc-consume-command.ts',
      './doc-revision-identifier.ts',
      './doc-set-source-files.ts',
      './local-doc-order.ts',
      './docs.ts',
    ],
    reason:
      'Keep doc commands independent of database writes beyond docs, runs, routing, transports, and the CLI.',
  },
] as const
