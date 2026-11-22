import type { ArchitectureModule } from './architecture.ts'

export const recordSecretMaskModules: ArchitectureModule[] = [
  {
    file: 'orchestrator/src/record/record-api-mask-warnings.ts',
    allowed: ['hono', 'shared/hosted-secret-mask.ts'],
  },
]
