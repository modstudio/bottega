export const RECORD_CLIENT_ADDRESSES_PATH = '/client-config'

export type RecordClientAddresses = {
  recordApiUrl: string
  hubHostedUrl: string
}

export function isHttpAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
