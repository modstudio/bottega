import { PLATFORM_SLUG } from './brand.ts'
import type { InstallationKind } from './install-root.ts'
import { refusal, renderRefusal } from './refusal.ts'

/** Name the recovery that can actually acquire a newer migration journal. */
export function storeAheadRemedy(kind: InstallationKind): string {
  return kind === 'checkout'
    ? `${PLATFORM_SLUG} machine update`
    : `reinstall the ${PLATFORM_SLUG} release that wrote this store, or a later one, with the installer`
}

export function storeAheadRefusal(
  ahead: string,
  kind: InstallationKind,
  invariant: string,
): string {
  return renderRefusal(
    refusal(
      `refusing to open a store ahead of this binary's migration journal: ${ahead}\n` +
        `invariant: ${invariant}`,
      { kind: 'edit', text: storeAheadRemedy(kind) },
    ),
  )
}
