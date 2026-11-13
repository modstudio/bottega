import type { ProjectSettings, StoredProjectSettings } from './project-settings.ts'

export function declaredRecordSpace(
  settings: ProjectSettings | StoredProjectSettings | undefined,
): string | null {
  const value = settings?.space
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Resolves a project's destination declaration, preferring a command override. */
export function declaredProjectRecordSpace(
  storedSettings: string | undefined,
  override?: string,
): string | null {
  if (override !== undefined) return declaredRecordSpace({ space: override })
  try {
    return storedSettings === undefined
      ? null
      : declaredRecordSpace(JSON.parse(storedSettings) as StoredProjectSettings)
  } catch {
    return null
  }
}
