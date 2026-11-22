import type { ArchitectureModule } from './architecture.ts'

export const recordSecretMaskModules: ArchitectureModule[] = [
  {
    file: 'orchestrator/src/record/record-api-secret-mask.ts',
    allowed: ['hono', 'shared/hosted-secret-mask.ts'],
  },
]
