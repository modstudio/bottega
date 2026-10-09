import type { CONCERNS } from '../shared/brand.ts'

export type ConcernManifest = {
  roots: typeof CONCERNS
  shared: { root: 'shared'; reason: string }
  exceptions: Array<{
    from: string
    to: string
    dependencyTypes: string[]
    reason: string
  }>
}
