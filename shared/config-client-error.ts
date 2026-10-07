import { RECORD_SIGN_IN_REMEDY } from './record-remedies.ts'

export type ConfigClientErrorReason = 'not-configured' | 'unreachable' | 'response'

export class ConfigClientError extends Error {
  readonly reason: ConfigClientErrorReason
  readonly route: string
  readonly status?: number
  constructor(
    reason: ConfigClientErrorReason,
    route: string,
    status?: number,
    details?: { url: string; contentType: string },
  ) {
    super(
      reason === 'not-configured'
        ? `hosted config is not configured; ${RECORD_SIGN_IN_REMEDY}`
        : reason === 'unreachable'
          ? `hosted config route ${route} is unreachable`
          : details
            ? `hosted config refused the response from ${details.url} (status ${status}, content type ${details.contentType}): expected JSON. ${RECORD_SIGN_IN_REMEDY}`
            : `hosted config route ${route} returned HTTP ${status}`,
    )
    this.name = 'ConfigClientError'
    this.reason = reason
    this.route = route
    this.status = status
  }
}
