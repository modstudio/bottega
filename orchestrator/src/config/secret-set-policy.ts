// concern: sealed-secret-set-policy
/** Owns blank-value refusal and repair text for sealed secret writes. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ConfigScope } from '../../../shared/config-client.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { sealedValueIsEmpty, stripTrailingNewline } from '../../../shared/sealed-value.ts'

function secretScopeFlag(scope: ConfigScope, spaceSlug?: string): string {
  return scope === 'space' ? ` --space ${spaceSlug ?? '<slug>'}` : ''
}

export function secretSetRemedy(key: string, scope: ConfigScope, spaceSlug?: string): string {
  return `${PLATFORM_SLUG} machine config secret set ${key}${secretScopeFlag(scope, spaceSlug)}`
}

export function secretDeleteRemedy(key: string, scope: ConfigScope, spaceSlug?: string): string {
  return `${PLATFORM_SLUG} machine config secret delete ${key}${secretScopeFlag(scope, spaceSlug)}`
}

export function sealedEmptyRefusal(key: string, scope: ConfigScope, spaceSlug?: string): string {
  return renderRefusal(
    refusal(`refusing to seal ${key}: the value piped on stdin is empty, so no value was sealed`, {
      kind: 'edit',
      text: `pipe the value on stdin to \`${secretSetRemedy(key, scope, spaceSlug)}\`, or remove the sealed value with \`${secretDeleteRemedy(key, scope, spaceSlug)}\``,
    }),
  )
}

export type SealedSecretSetDecision =
  | { kind: 'seal'; value: string }
  | { kind: 'refuse'; refusal: string }

export function sealSecretDecision(
  key: string,
  piped: string,
  scope: ConfigScope,
  spaceSlug?: string,
): SealedSecretSetDecision {
  if (!sealedValueIsEmpty(piped)) return { kind: 'seal', value: stripTrailingNewline(piped) }
  return { kind: 'refuse', refusal: sealedEmptyRefusal(key, scope, spaceSlug) }
}
