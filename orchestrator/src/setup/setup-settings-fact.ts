// concern: setup-settings-fact
/** Reads only local session and Claude settings state for setup planning. */

import { runtimeAssetRoot } from '../../../shared/runtime-assets.ts'
import { getDocStore as getDoc } from '../doc/doc-read-store.ts'
import { signedInDocOwner } from '../doc/docs.ts'
import { recordSessionPresent } from '../record/record-session.ts'
import { parseStoredOwnedSettings, SETTINGS_SCOPE, SETTINGS_SLUG } from '../settings/settings.ts'
import {
  claudeHomeFromEnvironment,
  readSettingsJsonLenient,
  userSettingsPath,
} from '../settings/settings-files.ts'
import {
  productHookDeclarations,
  type ProductHookDeclaration,
} from '../settings/settings-machine-hooks.ts'
import { classifySetupProductHooks, type SetupProductHookFact } from './setup-install-verify.ts'

export type SetupSettingsFact = {
  state: 'signed-in' | 'waiting-for-sign-in'
  hooks: SetupProductHookFact[]
  subagents: { blocking: 'on' | 'off'; source: 'user' | 'default' }
}

export async function gatherSetupSettingsFact(
  environment: NodeJS.ProcessEnv = process.env,
  adapters: {
    sessionPresent?: () => boolean
    assetRoot?: () => string
    owner?: () => Promise<string>
    settingsBody?: (owner: string) => string | null
  } = {},
): Promise<SetupSettingsFact> {
  const settings = readSettingsJsonLenient(userSettingsPath(claudeHomeFromEnvironment(environment)))
  const assetRoot = (adapters.assetRoot ?? (() => runtimeAssetRoot(environment)))()
  const signedIn = (adapters.sessionPresent ?? recordSessionPresent)()
  const owner = signedIn ? await (adapters.owner ?? signedInDocOwner)() : null
  const body = owner
    ? (
        adapters.settingsBody ??
        ((value) => getDoc(SETTINGS_SCOPE, null, SETTINGS_SLUG, value)?.body ?? null)
      )(owner)
    : null
  const options = body ? parseStoredOwnedSettings(body).options : undefined
  const declarations: readonly ProductHookDeclaration[] = productHookDeclarations(options)
  return {
    state: signedIn ? 'signed-in' : 'waiting-for-sign-in',
    hooks: classifySetupProductHooks({
      settings: settings.state === 'readable' ? settings.settings : undefined,
      readable: settings.state === 'readable',
      declarations,
      assetRoot: () => assetRoot,
    }),
    subagents: {
      blocking: options?.subagentHooks === 'on' ? 'on' : 'off',
      source: options?.subagentHooks === 'on' ? 'user' : 'default',
    },
  }
}
