import type { PLATFORM_NAME } from './brand.ts'

export type DistributionManifest = {
  name: typeof PLATFORM_NAME
  version: string
  built: string
  commit: string
}
