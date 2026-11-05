// concern: settings
/** The permission lists every settings layer shares; import-free so a browser bundle can carry it. */
export const SETTINGS_PERMISSION_LISTS = ['allow', 'ask', 'deny'] as const
export type SettingsPermissionList = (typeof SETTINGS_PERMISSION_LISTS)[number]
