// concern: project-set-space
/** Normalizes project set's two space inputs before the register write path. */

import { parseSettingsPatch } from './project-settings-patch.ts'

export async function projectSetSettingsPatch(
  settingsJson: string | undefined,
  selectedSpace: string | undefined,
  resolveSpaceId: (space: string) => Promise<string | null>,
): Promise<Record<string, unknown> | undefined> {
  const supplied = settingsJson === undefined ? undefined : parseSettingsPatch(settingsJson)
  if (selectedSpace === undefined) return supplied
  if (supplied && Object.hasOwn(supplied, 'space')) {
    const suppliedSpace = supplied.space
    if (typeof suppliedSpace !== 'string' || !suppliedSpace.trim()) {
      throw new Error('--space and settings.space must name the same record space')
    }
    const [selectedId, suppliedId] = await Promise.all([
      resolveSpaceId(selectedSpace),
      resolveSpaceId(suppliedSpace),
    ])
    const same =
      selectedId && suppliedId ? selectedId === suppliedId : selectedSpace === suppliedSpace
    if (!same) throw new Error('--space and settings.space must name the same record space')
  }
  return { ...supplied, space: selectedSpace }
}
