import type { ArchitectureModule } from './architecture.ts'

export const recordSecretMaskModules: ArchitectureModule[] = [
  {
    file: 'orchestrator/src/record/record-api-secret-mask.ts',
    allowed: [
      'hono',
      'shared/brand.ts',
      'shared/hosted-secret-mask.ts',
      'shared/record-sync-limits.ts',
    ],
  },
]
