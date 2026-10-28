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

export function resolveLandingTrunkTip(trunk: string, git: (args: string[]) => string): string {
  let remoteTrackingRefExists = false
  try {
    git(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${trunk}`])
    remoteTrackingRefExists = true
  } catch {}

  let localIsAncestorOfRemote = false
  if (remoteTrackingRefExists) {
    try {
      git(['merge-base', '--is-ancestor', '--end-of-options', trunk, `origin/${trunk}`])
      localIsAncestorOfRemote = true
    } catch {}
  }
  const ref = landingTrunkRef(trunk, {
    remoteTrackingRefExists,
    localIsAncestorOfRemote,
  })
  return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
}
