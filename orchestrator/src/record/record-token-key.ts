import type { RECORD_SESSION_KEY as LEGACY_RECORD_SESSION_KEY } from './record-auth.ts'

/** Keep the lightweight reader's key compatible with record-auth's public legacy export. */
export const RECORD_SESSION_KEY: typeof LEGACY_RECORD_SESSION_KEY = 'record_session'
