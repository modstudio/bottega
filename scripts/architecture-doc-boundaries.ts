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
      './doc-authoritative-read.ts',
      './doc-history-source.ts',
      '../identity/doc-revision-identity.ts',
      './doc-set-source-files.ts',
      './local-doc-order.ts',
      './docs.ts',
    ],
    reason:
      'Keep doc commands independent of database writes beyond docs, runs, routing, transports, and the CLI.',
  },
] as const

export function docLocalReadStoreAuthorityRule(exact: (path: string) => string) {
  return {
    name: 'doc-local-read-store-authority',
    severity: 'error' as const,
    comment:
      'Hosted-capable document reads reach local stores only through the authority adapter. DEV-2584 PR 2: canon and revision-id reads are temporary exceptions.',
    from: {
      path: '^orchestrator/src/',
      pathNot: [
        'orchestrator/src/doc/doc-authoritative-read.ts',
        'orchestrator/src/doc/doc-read-store.test.ts',
        'orchestrator/src/doc/doc-revision-store.test.ts',
        'orchestrator/src/doc/canon-import.ts',
        'orchestrator/src/doc/canon-removal.ts',
        'orchestrator/src/doc/context-service.ts',
        'orchestrator/src/doc/doc-article-fields.ts',
        'orchestrator/src/doc/doc-files.ts',
        'orchestrator/src/doc/doc-hosted-history.ts',
        'orchestrator/src/doc/doc-list.ts',
        'orchestrator/src/doc/doc-prose.ts',
        'orchestrator/src/doc/doc-remove.ts',
        'orchestrator/src/doc/doc-restore-state.ts',
        'orchestrator/src/doc/doc-revision-store.ts',
        'orchestrator/src/doc/doc-search-service.ts',
        'orchestrator/src/doc/docs.ts',
        'orchestrator/src/doc/local-doc-status.ts',
        'orchestrator/src/doc/local-doc-tree-service.ts',
        'orchestrator/src/doc/local-doc-write.ts',
        'orchestrator/src/doc/doc-hosted-write-operation.ts',
        'orchestrator/src/doc/doc-write-identity.ts',
        'orchestrator/src/doc/resume-brief-author.ts',
        'orchestrator/src/gate/gate-facts.ts',
        // DEV-2584 PR 2: canon pack compilation remains synchronous and local.
        'orchestrator/src/canon/canon-stored-rows.ts',
        // DEV-2584 PR 2: get_doc_revision remains local until revision-id lookup exists.
        'orchestrator/src/mcp/mcp-doc-tools.ts',
      ].map(exact),
    },
    to: {
      path: [
        'orchestrator/src/doc/doc-read-store.ts',
        'orchestrator/src/doc/doc-revision-store.ts',
      ]
        .map(exact)
        .join('|'),
    },
  }
}
