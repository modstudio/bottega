import type { ImportBoundary } from './architecture-boundaries.ts'

export const recordSettingsBoundarySpecs: ImportBoundary[] = [
  {
    name: 'record-api-settings-boundary',
    file: 'orchestrator/src/record/record-api-settings.ts',
    allowed: [
      'hono',
      'zod',
      'orchestrator/src/record/record-auth.ts',
      'orchestrator/src/record/record-settings.ts',
    ],
    typeOnlyAllowed: [],
    reason: 'Keep hosted settings routes independent of SQL and local execution.',
  },
  {
    name: 'record-settings-boundary',
    file: 'orchestrator/src/record/record-settings.ts',
    allowed: [
      'orchestrator/src/doc/doc-write-allowed.ts',
      'orchestrator/src/settings/settings.ts',
      'orchestrator/src/settings/settings-permission.ts',
      'orchestrator/src/record/record-docs.ts',
    ],
    typeOnlyAllowed: [],
    reason: 'Keep hosted settings edits independent of HTTP and local stores.',
  },
]
