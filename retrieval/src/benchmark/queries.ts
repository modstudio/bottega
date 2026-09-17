// concern: retrieval-queries
/** Fixed benchmark questions copied from canon, with their enforcing source files as gold. */

type BenchmarkQuery = {
  id: string
  query: string
  goldPath: string
  provenance: { path: string; excerpt: string }
}

const rule = (id: string, query: string, goldPath: string, path: string): BenchmarkQuery => ({
  id,
  query,
  goldPath,
  provenance: { path, excerpt: query },
})

export const BENCHMARK_QUERIES: BenchmarkQuery[] = [
  rule(
    'module-boundaries',
    'A module owns one concern, states what it knows and must not know, and is reached only through its exported service or schemas.',
    'scripts/check-architecture.ts',
    '.agents/rules/10-code.md',
  ),
  rule(
    'import-direction',
    'Imports follow the declared layer direction. Break cycles with explicit ports rather than upward imports.',
    'scripts/check-architecture.ts',
    '.agents/rules/10-code.md',
  ),
  rule(
    'engine-boundary',
    'Durable execution knows generic job identity, state, deadlines, retries, and suspension on input. Contracts decide what forces suspension, and routing owns failover.',
    'scripts/check-contract-boundary.ts',
    '.agents/rules/10-code.md',
  ),
  rule(
    'evidence-boundary',
    'Scoring, routing, and review consume execution records; execution never reads their conclusions.',
    'scripts/check-evidence-boundary.ts',
    '.agents/rules/10-code.md',
  ),
  rule(
    'whole-transactions',
    'A write transaction or lock ordering is the smallest unit that may move. The module that opens it owns every write inside it.',
    'scripts/check-write-transaction-site.ts',
    '.agents/rules/10-code.md',
  ),
  rule(
    'file-ceiling',
    'A production or test file at the ceiling may only shrink.',
    'scripts/check-file-ceiling.ts',
    '.agents/rules/10-code.md',
  ),
  rule(
    'complexity-ceiling',
    'A function at the cognitive complexity ceiling may only become simpler.',
    'scripts/check-cognitive-ceiling.ts',
    '.agents/rules/10-code.md',
  ),
  rule(
    'dead-code',
    'Code unused by production is dead and must be deleted with any test that exists only for it.',
    'scripts/check-dead-code.ts',
    '.agents/rules/10-code.md',
  ),
  rule(
    'manifest-boundaries',
    'An import restriction is a rule in architecture.ts or architecture-boundaries.ts.',
    'scripts/architecture.ts',
    '.agents/rules/10-code.md',
  ),
  rule(
    'machine-state',
    'A checkout holds source only. Databases, run artifacts, backups, locks and logs live in the per-user state directory that shared/state-directory.ts resolves; code never builds a state path from the checkout root.',
    'scripts/check-machine-state.ts',
    '.agents/rules/10-code.md',
  ),
  rule(
    'test-processes',
    'Gate tests run in process, spawn nothing, build no repository and complete far below the per-test timing budget.',
    'scripts/check-test-spawns.ts',
    '.agents/rules/30-tests.md',
  ),
  rule(
    'test-placement',
    'A unit test is <module>.test.ts beside its module so both move and split together.',
    'scripts/check-test-placement.ts',
    '.agents/rules/30-tests.md',
  ),
  rule(
    'test-observations',
    'Assert observable effects rather than interactions.',
    'scripts/quality/check-no-expect.ts',
    '.agents/rules/30-tests.md',
  ),
  rule(
    'test-fixtures',
    'Fixtures obey the same provisioning and release rule.',
    'scripts/check-test-fixtures.ts',
    '.agents/rules/40-caution.md',
  ),
  rule(
    'brand-location',
    'The product name lives only in shared/brand.ts; bun run check enforces that code does not duplicate it.',
    'scripts/check-brand.ts',
    'AGENTS.md',
  ),
  rule(
    'secrets-gate',
    'Gitleaks gates the repository, and its allowlist is limited to named fake fixture credentials in .gitleaks.toml.',
    'scripts/check-gitleaks.ts',
    'AGENTS.md',
  ),
  rule(
    'comment-history',
    'Canon, documentation and comments state the current rule, constraint or behaviour and what to do about it.',
    'scripts/check-comment-hygiene.ts',
    '.agents/rules/50-writing.md',
  ),
  rule(
    'review-consumes',
    'Evidence only consumes',
    'scripts/check-review-boundary.ts',
    '.agents/rules/10-code.md',
  ),
  rule(
    'hosted-hub-boundary',
    'The hosted record is one Postgres schema in shared/record, and each concern writes only its own tables through its own services.',
    'scripts/check-hosted-hub-server-boundary.ts',
    'AGENTS.md',
  ),
  rule(
    'suite-budget',
    'Suite time is shared and bun run check reports the budget.',
    'scripts/check-runtime.ts',
    '.agents/rules/30-tests.md',
  ),
]
