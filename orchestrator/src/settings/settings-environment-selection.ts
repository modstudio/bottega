// concern: settings-environment-selection
/** Selects required per-machine settings values and reports every missing name. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import type { OwnedSettings } from './settings.ts'
import { renderedSettingsEnvironment } from './settings-render.ts'

export function missingSettingsEnvironmentRefusal(path: string, names: readonly string[]): string {
  return [
    `refusing settings render: per-machine env values are missing from ${path}`,
    ...names.map((name) =>
      renderRefusal(
        refusal(name, {
          kind: 'edit',
          text:
            `add ${name} to ${path} with mode 0600, or, if it is not a secret, run ` +
            `\`${PLATFORM_SLUG} machine settings env set ${name} <value>\``,
        }),
      ),
    ),
  ].join('\n')
}

export function environmentForSettingsApply(
  owned: OwnedSettings,
  selected: Record<string, string>,
  missing: readonly string[],
  fileExists: boolean,
): Record<string, string> | undefined {
  if (missing.length === 0) return renderedSettingsEnvironment(owned, selected)
  return fileExists ? undefined : { ...(owned.env ?? {}) }
}
