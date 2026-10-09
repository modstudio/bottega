// concern: retrieval-queries
/** Fixed code statements and agent-shaped doc questions with their labeled answers. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type LabeledQuery = {
  id: string
  query: string
  goldLabels: string[]
}

export type BenchmarkQuery = LabeledQuery & {
  provenance: { path: string; excerpt: string }
}

export type DocBenchmarkQuery = LabeledQuery & {
  scope: 'project' | 'global' | 'agent' | 'machine' | 'job' | 'canon'
  provenance: { doc: string; excerpt: string }
}

const rule = (id: string, query: string, goldPath: string, path: string): BenchmarkQuery => ({
  id,
  query,
  goldLabels: [goldPath],
  provenance: { path, excerpt: query },
})

export const CODE_QUERIES: BenchmarkQuery[] = [
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
    'scripts/quality/check-test-substance.ts',
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
    'Canon, documentation and comments state the current rule, constraint or behavior and what to do about it.',
    'orchestrator/src/check/check-comments.ts',
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

const codeQuestion = (
  id: string,
  query: string,
  goldPath: string,
  excerpt: string,
  otherAnswers: string[] = [],
): BenchmarkQuery => ({
  id,
  query,
  goldLabels: [goldPath, ...otherAnswers],
  provenance: { path: goldPath, excerpt },
})

export const REAL_CODE_QUERIES: BenchmarkQuery[] = [
  codeQuestion(
    'real-routing-eligibility',
    'Where does routing decide which agents are eligible for a job?',
    'orchestrator/src/route/route.ts',
    'if (declared && !declared.includes(jobName)) {',
  ),
  codeQuestion(
    'real-mcp-probe-tool-error',
    'Where is an MCP probe result judged a failure when the tool returns an error?',
    'orchestrator/src/mcp/mcp-probe.ts',
    'if (response?.result?.isError !== true) continue',
  ),
  codeQuestion(
    'real-review-merge-base',
    'What resolves the merge base for a review target?',
    'orchestrator/src/review/review-target.ts',
    "return gitContext(cwd, 'merge-base', commit, trunkCommit)",
  ),
  codeQuestion(
    'real-continue-tree',
    'How does orch continue decide which worktree and branch to resume?',
    'orchestrator/src/run/resume-tree.ts',
    "source: 'latest turn branch',",
  ),
  codeQuestion(
    'real-project-settings-validation',
    "Where are a project's register settings validated?",
    'orchestrator/src/project/projects.ts',
    'export function validateProjectSettings(settings: ProjectSettings, projectPath?: string): string[] {',
  ),
  codeQuestion(
    'real-wait-asking',
    'What makes orch wait return when a worker starts asking a question?',
    'orchestrator/src/collect/collect.ts',
    "asking?.state === 'open'",
  ),
  codeQuestion(
    'real-hosted-project-columns',
    'Where does hosted import map project settings to database columns?',
    'orchestrator/src/postgres/postgres-import.ts',
    'const columns = hostedProjectColumns(settings, row.name)',
    ['orchestrator/src/record/record-project-columns.ts'],
  ),
  codeQuestion(
    'real-score-refusal',
    'Where is a score refused because the run is not evidence, or because a void targets a child turn?',
    'orchestrator/src/verdict/verdict-rules.ts',
    'export function refuseChildTurnVoid(',
  ),
  codeQuestion(
    'real-outbox-push-order',
    'What pushes outbox rows to the hosted record, and in what order?',
    'orchestrator/src/record/record-sync.ts',
    'const [leftPhase, leftId] = outboxOrder(left.kind, left.id)',
  ),
  codeQuestion(
    'real-hosted-doc-list',
    'Where are hosted docs listed for a space?',
    'orchestrator/src/record/record-docs.ts',
    'export async function listRecordDocs(input: Tenant & RecordDocListInput): Promise<RecordDoc[]> {',
  ),
  codeQuestion(
    'real-report-rendering',
    "Where is the report email's text and HTML rendered?",
    'hub/src/report-renderer.ts',
    'export function renderHtml(',
  ),
  codeQuestion(
    'real-report-measures',
    'What computes tasks done and cycle time for reports?',
    'hub/src/measures.ts',
    'const cycleTime = cycleTimeOf(rows, events, from, to)',
  ),
  codeQuestion(
    'real-file-ceiling',
    'Where is the per-file line ceiling enforced?',
    'scripts/check-file-ceiling.ts',
    'const decision = decideCeiling({',
  ),
  codeQuestion(
    'real-retrieval-command',
    'Where does orch spawn the retrieval search command and parse its output?',
    'orchestrator/src/doc/doc-search.ts',
    'const child = Bun.spawn([',
  ),
  codeQuestion(
    'real-reply-source',
    "Where does a run choose the reply file over the transport's final message?",
    'orchestrator/src/run/run-reply-source.ts',
    'if (facts.replyFile.present) {',
  ),
  codeQuestion(
    'real-grok-tool-limit',
    "Where is grok's MCP tool-name limit declared?",
    'orchestrator/src/agent/agents.ts',
    'mcpToolNamePattern:',
  ),
  codeQuestion(
    'real-comment-checks',
    'What finds task keys and history phrases in code comments?',
    'orchestrator/src/check/check-comments.ts',
    'export function commentFindings(comment: CommentSource, rules: CommentRules): CommentFinding[] {',
  ),
  codeQuestion(
    'real-review-tier',
    "How is a change's review tier computed from risk and size?",
    'orchestrator/src/review/review-tier.ts',
    'return { tier: Math.max(risk, size) as 0 | 1 | 2 | 3, risk, size, reasons }',
  ),
  codeQuestion(
    'real-canon-hydration',
    "Where are canon rows written into a worktree's files?",
    'orchestrator/src/canon/canon-commands.ts',
    'writeFileSync(target, body)',
  ),
  codeQuestion(
    'real-doc-lint',
    'What lints a doc when it is written to the store?',
    'orchestrator/src/doc/doc-lint.ts',
    'export function lintDoc(doc: LintableDoc): DocLintFinding[] {',
  ),
  codeQuestion(
    'real-mcp-tool-compatibility',
    "What decides whether an agent can use a project MCP server's tool names?",
    'orchestrator/src/mcp/mcp-compatibility.ts',
    'const admitted = pattern ? listed.filter((name) => new RegExp(pattern).test(name)) : [...listed]',
  ),
  codeQuestion(
    'real-orphan-removal',
    'Where does sweep decide whether an orphaned worktree directory is safe to remove?',
    'orchestrator/src/cleanup/cleanup-sweep-decisions.ts',
    'if (!facts.safe.removable) {',
  ),
  codeQuestion(
    'real-index-stale-write',
    'Where is the stale-write check applied when the search index refreshes?',
    'retrieval/src/index-store.ts',
    'if (!sameIdentity(observedIdentity(candidate.chunk.id), candidate.observed)) {',
  ),
  codeQuestion(
    'real-model-host-reachability',
    'How does orch decide the local model host is reachable?',
    'orchestrator/src/agent/model-host.ts',
    "const res = await fetch(new URL('models', baseUrl.replace(/\\/?$/, '/')), {",
  ),
  codeQuestion(
    'real-workflow-step-slug',
    'Where is a numbered workflow step turned into a step slug?',
    'orchestrator/src/workflow/workflow-step-reference.ts',
    'if (slugs.size === 1) return candidates[0]!.step',
  ),
]

const doc = (
  id: string,
  query: string,
  scope: DocBenchmarkQuery['scope'],
  subject: string | null,
  slug: string,
  excerpt: string,
  otherAnswers: string[] = [],
): DocBenchmarkQuery => {
  const label = `doc:${scope}/${subject ?? '_'}/${slug}`
  return {
    id,
    query,
    scope,
    goldLabels: [label, ...otherAnswers],
    provenance: { doc: label, excerpt },
  }
}

export const DOC_QUERIES: DocBenchmarkQuery[] = [
  doc(
    'doc-knowledge-order',
    'What has to be measured before we build semantic search for agents?',
    'project',
    PLATFORM_SLUG,
    'roadmap',
    "Measure how often agents' real questions find the right doc, comparing keyword, embeddings and rerank.",
  ),
  doc(
    'doc-mcp-routing',
    'How should routing react when an agent cannot use a project server’s tool names?',
    'project',
    PLATFORM_SLUG,
    'design-mcp-agent-compatibility',
    'When a job requires a server, routing does not send it to an agent that is incompatible with that server, and a run whose own probe shows the mismatch refuses before launch.',
  ),
  doc(
    'doc-durable-engine-revisit',
    'When should we reconsider using a maintained engine for run supervision?',
    'project',
    PLATFORM_SLUG,
    'durable-execution-decision',
    'Ask again when any of these becomes true:',
  ),
  doc(
    'doc-hosted-secrets-cache',
    'May a local cache ever hold plaintext user secrets from the hosted record?',
    'project',
    PLATFORM_SLUG,
    'hosted-config-design',
    'A local cache may hold secret rows only as ciphertext.',
  ),
  doc(
    'doc-product-boundary',
    'Are tasks and development workflows product behavior or replaceable plumbing here?',
    'project',
    PLATFORM_SLUG,
    'system-map',
    'Tasks and workflows are product, not machinery. They are the surfaces the other projects take from here instead of maintaining four drifting copies.',
  ),
  doc(
    'doc-worktree-no-preference',
    'What provisioning shape should a project use when it has no existing preference?',
    'global',
    null,
    'default-worktree-provisioning',
    `One file, \`${PLATFORM_SLUG}.jsonc\`, at the project root, with a \`worktree\` key.`,
  ),
  doc(
    'doc-worktree-allocation-ownership',
    'Who allocates ports and who creates the database for a disposable checkout?',
    'global',
    null,
    'default-worktree-provisioning',
    'Orch allocates and claims; the project creates and destroys.',
  ),
  doc(
    'doc-port-bun-layout',
    'How do I translate a portable TypeScript module between Stopal and Adanim?',
    'global',
    null,
    'port-stack-mapping',
    'stopal is flat `apps/api/src/modules/<name>/`, adanim splits',
  ),
  doc(
    'doc-port-reflected-tools',
    'Where do I add a callable tool in Adanim if there are no hand-written tool files?',
    'global',
    null,
    'port-category-map',
    'MCP tools are reflected, not hand-written',
  ),
  doc(
    'doc-codex-paginated-tools',
    'Why can Codex connect to an MCP server but still fail to see some of its tools?',
    'agent',
    'codex',
    'mcp-registration',
    "Codex reads only the first page of a server's `tools/list`.",
  ),
  doc(
    'doc-grok-project-server',
    'Where does Grok discover a repository-local MCP server configuration?',
    'agent',
    'grok',
    'capabilities-observed',
    'It discovers `<project>/.mcp.json` from its WORKING DIRECTORY — its own doctor names the source as `mcpJson` with the path — from both a main checkout and from a worktree carrying the `.mcp.json` symlink.',
  ),
  doc(
    'doc-qwen-schema',
    'Can the local Qwen agent enforce a JSON schema in its current CLI version?',
    'agent',
    'qwen-local',
    'capabilities-observed',
    'version 0.7.1 does not implement it.',
  ),
  doc(
    'doc-gx10-memory-sizing',
    'What command should I trust for model memory sizing on the local AI box?',
    'machine',
    null,
    'local-model-host-hardware',
    'Use `free -h`.',
  ),
  doc(
    'doc-gx10-network-bottleneck',
    'Would upgrading the LAN make local model generation meaningfully faster?',
    'machine',
    null,
    'local-model-host-network',
    "Against a 16.7 ms per-token decode, the network is never the bottleneck — a full context pack crosses in less than a sixth of one token's generation time. Faster networking would buy nothing.",
  ),
  doc(
    'doc-gx10-retrieval-tunnel',
    'Which local forwards carry embeddings and reranking, and why are they separate from generation?',
    'machine',
    null,
    'local-model-host-tunnel',
    '`com.user.gx10-services-tunnel` carries the retrieval services. The second is not folded into the first so that a fault in retrieval cannot take the model endpoint down.',
  ),
  doc(
    'doc-gx10-outage-attribution',
    'How do we avoid scoring the local model for a failure caused by the host being offline?',
    'machine',
    null,
    'local-model-host-incidents',
    'two verdicts against a model that was never consulted',
  ),
  doc(
    'doc-inline-review-evidence',
    'How can a readless review agent receive enough evidence to judge a normal commit?',
    'job',
    'review-lens-inline',
    'self-contained-pack',
    'A diff is already a self-contained pack.',
  ),
  doc(
    'doc-worker-decision',
    'What should a worker do when implementation reaches a genuine judgment call?',
    'canon',
    PLATFORM_SLUG,
    '.agents/rules/00-principles.md',
    'A worker that reaches a judgment call stops and asks.',
  ),
  doc(
    'doc-transaction-owner',
    'Which module owns all writes made inside a transaction?',
    'canon',
    PLATFORM_SLUG,
    '.agents/rules/10-code.md',
    'The module that opens it owns every write inside it.',
  ),
  doc(
    'doc-research-duty',
    'Who must research maintained alternatives before a build task is specified?',
    'canon',
    PLATFORM_SLUG,
    '.agents/rules/20-build-and-buy.md',
    'The architect researches current practice and maintained solutions before specifying and dispatching work. This cannot be delegated to a networkless worker or answered from memory.',
  ),
  doc(
    'doc-unit-test-location',
    'Where should a unit test live so it moves with its subject?',
    'canon',
    PLATFORM_SLUG,
    '.agents/rules/30-tests.md',
    'A unit test is `<module>.test.ts` beside its module',
  ),
  doc(
    'doc-teardown-ownership',
    'Who is responsible for releasing a resource created during ordinary work?',
    'canon',
    PLATFORM_SLUG,
    '.agents/rules/40-caution.md',
    'The task that provisions a resource tears it down.',
  ),
  doc(
    'doc-current-documentation',
    'Should documentation explain the historical sequence that produced the current rule?',
    'canon',
    PLATFORM_SLUG,
    '.agents/rules/50-writing.md',
    'Never narrate former names, abandoned approaches, dated decisions or the sequence by which the current state arose; Git holds that record.',
  ),
  doc(
    'doc-suggestion-promotion',
    'Can scheduled curation turn an observation into a task automatically?',
    'canon',
    PLATFORM_SLUG,
    '.agents/rules/60-tasks.md',
    'Promotion is always a human act',
  ),
  doc(
    'doc-unanswered-worker',
    'May a run continue while its implementation worker is waiting for a ruling?',
    'canon',
    PLATFORM_SLUG,
    '.agents/rules/70-sessions.md',
    'Never continue or land a chain while its worker has an unanswered question',
  ),
]
