// concern: setup-settings-fact
/** Reads only local session and Claude settings state for setup planning. */

import { runtimeAssetRoot } from '../../../shared/runtime-assets.ts'
import { recordSessionPresent } from '../record/record-session.ts'
import {
  claudeHomeFromEnvironment,
  readSettingsJsonLenient,
  userSettingsPath,
} from '../settings/settings-files.ts'
import { PRODUCT_HOOKS } from '../settings/settings-machine-hooks.ts'
import { classifySetupProductHooks, type SetupProductHookFact } from './setup-install-verify.ts'

export type SetupSettingsFact = {
  state: 'signed-in' | 'waiting-for-sign-in'
  hooks: SetupProductHookFact[]
}

export function gatherSetupSettingsFact(
  environment: NodeJS.ProcessEnv = process.env,
  adapters: {
    sessionPresent?: () => boolean
    assetRoot?: () => string
  } = {},
): SetupSettingsFact {
  const settings = readSettingsJsonLenient(userSettingsPath(claudeHomeFromEnvironment(environment)))
  const assetRoot = (adapters.assetRoot ?? (() => runtimeAssetRoot(environment)))()
  return {
    state: (adapters.sessionPresent ?? recordSessionPresent)()
      ? 'signed-in'
      : 'waiting-for-sign-in',
    hooks: classifySetupProductHooks({
      settings: settings.state === 'readable' ? settings.settings : undefined,
      readable: settings.state === 'readable',
      declarations: PRODUCT_HOOKS,
      assetRoot: () => assetRoot,
    }),
  }
}
