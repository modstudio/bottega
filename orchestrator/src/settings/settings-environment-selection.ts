// concern: settings-environment-selection
/** Selects required per-machine settings values and reports every missing name. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { readSettingsEnv, selectedSettingsEnvironment } from './settings-env.ts'

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

function selectSettingsEnvironment(path: string, names: readonly string[]) {
  return selectedSettingsEnvironment(readSettingsEnv(path), names)
}

export function requireSettingsEnvironment(
  path: string,
  names: readonly string[],
): Record<string, string> {
  const selection = selectSettingsEnvironment(path, names)
  if (selection.missing.length > 0) {
    throw new Error(missingSettingsEnvironmentRefusal(path, selection.missing))
  }
  return selection.selected
}
