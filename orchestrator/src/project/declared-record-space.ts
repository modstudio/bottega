import type { ProjectSettings, StoredProjectSettings } from './project-settings.ts'

export function declaredRecordSpace(
  settings: ProjectSettings | StoredProjectSettings | undefined,
): string | null {
  const value = settings?.space
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
