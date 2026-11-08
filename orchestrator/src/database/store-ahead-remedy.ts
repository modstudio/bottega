import { PLATFORM_SLUG } from '../../../shared/brand.ts'

/** Name the recovery that can actually acquire a newer migration journal. */
export function storeAheadRemedy(kind: 'checkout' | 'distribution'): string {
  return kind === 'checkout'
    ? `${PLATFORM_SLUG} machine update`
    : `reinstall the ${PLATFORM_SLUG} release that wrote this store, or a later one, with the installer`
}
