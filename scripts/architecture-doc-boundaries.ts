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
      './doc-order-service.ts',
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
    comment: 'Hosted-capable document reads reach local stores only through the authority adapter.',
    from: {
      path: '^orchestrator/src/',
      pathNot: [
        // Authority adapter: the only hosted-capable entry to local document reads.
        'orchestrator/src/doc/doc-authoritative-read.ts',
        // Store contract tests exercise the local store directly.
        'orchestrator/src/doc/doc-read-store.test.ts',
        // Store contract tests exercise the local revision store directly.
        'orchestrator/src/doc/doc-revision-store.test.ts',
        // Write path: canon import compares and commits local rows atomically.
        'orchestrator/src/doc/canon-import.ts',
        // Write path: canon removal evaluates the local set it mutates.
        'orchestrator/src/doc/canon-removal.ts',
        // Local-install branch of sessionResumeBriefState.
        'orchestrator/src/doc/context-service.ts',
        // Write path: article validation operates on the candidate local row types.
        'orchestrator/src/doc/doc-article-fields.ts',
        // Write path: import/export serializes local rows around document mutations.
        'orchestrator/src/doc/doc-files.ts',
        // Adapter helper: presents revisions already selected by the authority adapter.
        'orchestrator/src/doc/doc-hosted-history.ts',
        // Write path: validates the local revision before a hosted write.
        'orchestrator/src/doc/doc-hosted-write-operation.ts',
        // Write path: prose validation consumes the candidate local document type.
        'orchestrator/src/doc/doc-prose.ts',
        // Write path: removal records a local revision and tombstone.
        'orchestrator/src/doc/doc-remove.ts',
        // Write path: restore compares the local current row with the selected revision.
        'orchestrator/src/doc/doc-restore-state.ts',
        // Store implementation: revision rows map through document store types.
        'orchestrator/src/doc/doc-revision-store.ts',
        // search out of scope (note 01a20248)
        'orchestrator/src/doc/doc-search-service.ts',
        // Local-install document branches.
        'orchestrator/src/doc/docs.ts',
        // Write path: local lifecycle validation checks replacement rows.
        'orchestrator/src/doc/local-doc-status.ts',
        // Write path: local tree validation reads parent and sibling rows.
        'orchestrator/src/doc/local-doc-tree-service.ts',
        // Write path: local mutation implementation reads the rows it changes.
        'orchestrator/src/doc/local-doc-write.ts',
        // Write path: resume authorship follows revisions created by resume mutations.
        'orchestrator/src/doc/resume-brief-author.ts',
        // Write path: derives the identity attached to a local revision mutation.
        'orchestrator/src/doc/doc-write-identity.ts',
        // Write path: ruling filing reads the revision written in the same operation.
        'orchestrator/src/commands/rulings.ts',
        // Write path: ruling filing reads the revision written in the same operation.
        'orchestrator/src/mcp/mcp-operator-tools.ts',
        // Write path: machine apply reads the local rows it materializes.
        'orchestrator/src/settings/settings-machine-apply.ts',
      ].map(exact),
    },
    to: {
      path: ['orchestrator/src/doc/doc-read-store.ts', 'orchestrator/src/doc/doc-revision-store.ts']
        .map(exact)
        .join('|'),
    },
  }
}
