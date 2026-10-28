// concern: branch-trunk-tip
/**
 * Knows how landing selects a fetched trunk. Must not know how Git is run or
 * which environment it uses.
 */

export function landingTrunkRef(
  trunk: string,
  facts: { remoteTrackingRefExists: boolean; localIsAncestorOfRemote: boolean },
): string {
  return facts.remoteTrackingRefExists && facts.localIsAncestorOfRemote ? `origin/${trunk}` : trunk
}

export function resolveLandingTrunkTip(
  trunk: string,
  probe: (args: string[]) => boolean,
  revParse: (ref: string) => string,
): string {
  const remoteTrackingRefExists = probe([
    'show-ref',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${trunk}`,
  ])
  const localIsAncestorOfRemote =
    remoteTrackingRefExists &&
    probe(['merge-base', '--is-ancestor', '--end-of-options', trunk, `origin/${trunk}`])
  const ref = landingTrunkRef(trunk, {
    remoteTrackingRefExists,
    localIsAncestorOfRemote,
  })
  return revParse(`${ref}^{commit}`)
}
