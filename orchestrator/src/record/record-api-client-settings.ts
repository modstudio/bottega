// concern: record-api-client-settings
/** Declares the hosted settings client surface without transport state. */
import type { RecordRequestDestination } from './record-api-client-paths.ts'
import type {
  RecordSettingsAutoModeInput,
  RecordSettingsAutoModeResult,
  RecordSettingsPermissionInput,
  RecordSettingsPermissionResult,
} from './record-settings.ts'

export type RecordSettingsClient = {
  applySettingsPermission(
    input: Omit<RecordSettingsPermissionInput, 'url' | 'userId' | 'spaceId' | 'spaceIds'>,
    destination?: RecordRequestDestination,
  ): Promise<RecordSettingsPermissionResult>
  applySettingsAutoMode(
    input: Omit<RecordSettingsAutoModeInput, 'url' | 'userId' | 'spaceId' | 'spaceIds'>,
    destination?: RecordRequestDestination,
  ): Promise<RecordSettingsAutoModeResult>
}
