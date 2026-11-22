// concern: setup-settings-fact
/** Reads only local session and Claude settings state for setup planning. */

import { runtimeAssetRoot } from '../../../shared/runtime-assets.ts'
import { recordSessionPresent } from '../record/record-session.ts'
import {
  claudeHomeFromEnvironment,
  readSettingsJsonLenient,
  userSettingsPath,
} from '../settings/settings-files.ts'
import { subagentBlockingState } from '../settings/settings.ts'
import {
  type ProductHookDeclaration,
  productHookDeclarations,
} from '../settings/settings-machine-hooks.ts'
import { readSignedInSubagentHooks } from '../settings/settings-user-row.ts'
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
    subagentHooks?: () => Promise<'on' | undefined>
  } = {},
): Promise<SetupSettingsFact> {
  const settings = readSettingsJsonLenient(userSettingsPath(claudeHomeFromEnvironment(environment)))
  const assetRoot = (adapters.assetRoot ?? (() => runtimeAssetRoot(environment)))()
  const signedIn = (adapters.sessionPresent ?? recordSessionPresent)()
  const subagentHooks = signedIn
    ? await (adapters.subagentHooks ?? readSignedInSubagentHooks)()
    : undefined
  const options = subagentHooks === 'on' ? { subagentHooks } : undefined
  const declarations: readonly ProductHookDeclaration[] = productHookDeclarations(options)
  return {
    state: signedIn ? 'signed-in' : 'waiting-for-sign-in',
    hooks: classifySetupProductHooks({
      settings: settings.state === 'readable' ? settings.settings : undefined,
      readable: settings.state === 'readable',
      declarations,
      assetRoot: () => assetRoot,
    }),
    subagents: subagentBlockingState(options),
  }
}
