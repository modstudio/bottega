import parser from '@typescript-eslint/parser'
import sonarjs from 'eslint-plugin-sonarjs'

const importMetaUrlPathnameSelector = {
  selector:
    "MemberExpression[property.name='pathname'][object.type='NewExpression'][object.callee.name='URL'][object.arguments.1.type='MemberExpression'][object.arguments.1.object.type='MetaProperty'][object.arguments.1.object.meta.name='import'][object.arguments.1.object.property.name='meta'][object.arguments.1.property.name='url']",
  message: 'Use fileURLToPath(new URL(..., import.meta.url)) for filesystem paths.',
}

const recordPushModules = [
  'orchestrator/src/record/outbox-failure.ts',
  'orchestrator/src/record/outbox-held-contract.ts',
  'orchestrator/src/record/outbox-payload-contracts.ts',
  'orchestrator/src/record/record-evidence-references.ts',
  'orchestrator/src/record/record-payload-columns.ts',
  'orchestrator/src/record/record-project-identity.ts',
  'orchestrator/src/record/record-question-values.ts',
  'orchestrator/src/record/record-release-sync.ts',
  'orchestrator/src/record/record-review-lens-values.ts',
  'orchestrator/src/record/record-review-read.ts',
  'orchestrator/src/record/record-review-values.ts',
  'orchestrator/src/record/record-run-usage.ts',
  'orchestrator/src/record/record-sequence.ts',
  'orchestrator/src/record/record-sync-branch-disposal.ts',
  'orchestrator/src/record/record-sync-brief-injection.ts',
  'orchestrator/src/record/record-sync-context-review.ts',
  'orchestrator/src/record/record-sync-contract.ts',
  'orchestrator/src/record/record-sync-decision.ts',
  'orchestrator/src/record/record-sync-evidence-lookup.ts',
  'orchestrator/src/record/record-sync-hook-emission.ts',
  'orchestrator/src/record/record-sync-principal.ts',
  'orchestrator/src/record/record-sync-project-identity.ts',
  'orchestrator/src/record/record-sync-pull-request-ci.ts',
  'orchestrator/src/record/record-sync-review-funnel.ts',
  'orchestrator/src/record/record-sync-run-task-identity.ts',
  'orchestrator/src/record/record-sync-run-values.ts',
  'orchestrator/src/record/record-sync-service.ts',
  'orchestrator/src/record/record-sync-task-flow.ts',
  'orchestrator/src/record/record-value-conversions.ts',
  'orchestrator/src/record/record-verdicts.ts',
  'orchestrator/src/record/score-sync.ts',
]

export default [
  {
    ignores: ['hub/web/src/routeTree.gen.ts', '**/migrations/meta/**'],
  },
  {
    files: [
      'orchestrator/src/**/*.{ts,tsx}',
      'orchestrator/test/**/*.{ts,tsx}',
      'hub/src/**/*.{ts,tsx}',
      'hub/web/src/**/*.{ts,tsx}',
      'shared/**/*.{ts,tsx}',
      'scripts/**/*.{ts,tsx}',
    ],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { sonarjs },
    rules: {
      'no-restricted-syntax': ['error', importMetaUrlPathnameSelector],
      'sonarjs/cognitive-complexity': ['error', 15],
    },
  },
  {
    files: recordPushModules,
    rules: {
      'no-restricted-syntax': [
        'error',
        importMetaUrlPathnameSelector,
        {
          selector: "ThrowStatement > NewExpression[callee.name='Error']",
          message:
            'record push modules throw OutboxRowError for row content (row-fatal) or RecordSyncWiringError for wiring invariants (pass-fatal); a bare Error fails the whole sync batch',
        },
      ],
    },
  },
]
