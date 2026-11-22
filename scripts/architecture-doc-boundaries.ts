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
        // Write path: context/resume persistence checks the local row it mutates.
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
        // Write path: command source-file edits read the prior row they replace.
        'orchestrator/src/doc/doc-set-source-files.ts',
        // Write path: document service mutations read their prior local rows.
        'orchestrator/src/doc/docs.ts',
        // Write path: local lifecycle validation checks replacement rows.
        'orchestrator/src/doc/local-doc-status.ts',
        // Write path: local tree validation reads parent and sibling rows.
        'orchestrator/src/doc/local-doc-tree-service.ts',
        // Write path: local mutation implementation reads the rows it changes.
        'orchestrator/src/doc/local-doc-write.ts',
        // Write path: generated reference publishing compares rows before replacing them.
        'orchestrator/src/doc/reference-publish.ts',
        // Write path: resume authorship follows revisions created by resume mutations.
        'orchestrator/src/doc/resume-brief-author.ts',
        // Write path: derives the identity attached to a local revision mutation.
        'orchestrator/src/doc/doc-write-identity.ts',
        // PR 2: gate facts compile the local canon/injection pack synchronously.
        'orchestrator/src/gate/gate-facts.ts',
        // Write path: ruling filing reads the revision written in the same operation.
        'orchestrator/src/commands/rulings.ts',
        // Write path: ruling filing reads the revision written in the same operation.
        'orchestrator/src/mcp/mcp-operator-tools.ts',
        // Write path: settings import reads the prior row it updates.
        'orchestrator/src/settings/settings-apply-commands.ts',
        // Review admission remains synchronous while its policy snapshot is evaluated.
        'orchestrator/src/review-funnel/review-funnel-policy.ts',
        // Write path: settings commands read the prior row they update.
        'orchestrator/src/settings/settings-commands.ts',
        // Write path: settings env edits read the prior row they update.
        'orchestrator/src/settings/settings-env-commands.ts',
        // Write path: machine apply reads the local rows it materializes.
        'orchestrator/src/settings/settings-machine-apply.ts',
        // PR 2: canon commands remain synchronous and local.
        'orchestrator/src/canon/canon-commands.ts',
        // PR 2: canon pack compilation remains synchronous and local.
        'orchestrator/src/canon/canon-stored-rows.ts',
        // PR 2: canon pack compile/hydrate/list/check/diff/evals remain local.
        'orchestrator/src/canon/canon.ts',
        // PR 2: user canon hydrate/list/check/diff remains local.
        'orchestrator/src/canon/user-canon-commands.ts',
        // PR 2: get_doc_revision remains local until revision-id lookup exists.
        'orchestrator/src/mcp/mcp-doc-tools.ts',
      ].map(exact),
    },
    to: {
      path: ['orchestrator/src/doc/doc-read-store.ts', 'orchestrator/src/doc/doc-revision-store.ts']
        .map(exact)
        .join('|'),
    },
  }
}
