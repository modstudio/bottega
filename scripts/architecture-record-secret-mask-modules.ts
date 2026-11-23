import type { ArchitectureModule } from './architecture.ts'

export const recordSecretMaskModules: ArchitectureModule[] = [
  {
    file: 'orchestrator/src/record/record-api-mask-warnings.ts',
    allowed: ['hono', 'shared/hosted-secret-mask.ts'],
  },
  {
    file: 'orchestrator/src/record/record-workflow-catalogue.ts',
    allowed: [
      'bun',
      'shared/hosted-secret-mask.ts',
      'shared/record/schema.ts',
      'shared/record/tenant.ts',
      'orchestrator/src/record/record-cursor.ts',
      'orchestrator/src/record/record-workflow-contract.ts',
      'orchestrator/src/record/record-pool.ts',
    ],
  },
]
