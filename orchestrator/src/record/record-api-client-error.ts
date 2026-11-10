// concern: record-api-client-error
/** Classifies shared record HTTP and transport failures for the client. */
import {
  type HostedRequestSafety,
  RECORD_ACTIVE_SPACE_REMEDY,
  RECORD_SIGN_IN_REMEDY,
  recordUnreachableRefusal,
} from '../../../shared/record-remedies.ts'
import { RECORD_WRITE_REMEDY } from '../doc/doc-write-allowed.ts'
import { revisionConflictBodySchema } from '../doc/doc-revision-conflict.ts'
import {
  RecordApiRequestError,
  responseCode,
  responseMessage,
  responseRecord,
} from './record-api-client-response.ts'
import { parseProjectSpaceConflictResponse } from './record-project-space-contract.ts'

const recordApiStatus = (status: number) => `record API ${status}`

export function recordApiUnreachable(
  error: unknown,
  origin: string,
  outcome: HostedRequestSafety,
): RecordApiRequestError {
  const detail = error instanceof Error ? error.message : String(error)
  return new RecordApiRequestError(recordUnreachableRefusal(origin, detail, outcome), 'unreachable')
}

function recordApiServerError(message: string, status: number): RecordApiRequestError {
  const fallback = recordApiStatus(status)
  const statusMessage = message === fallback ? message : `${fallback}: ${message}`
  return new RecordApiRequestError(`${statusMessage}\n${RECORD_WRITE_REMEDY}`, 'server', status)
}

export function recordApiError(
  body: unknown,
  status: number,
  headers: Headers = new Headers(),
): Error {
  if (status === 401) return recordAuthRefusal(status, body, headers)
  const projectSpaceConflict = parseProjectSpaceConflictResponse(body, status)
  if (projectSpaceConflict) return projectSpaceConflict
  const revisionConflict = revisionConflictBodySchema.safeParse(body)
  if (
    status === 409 &&
    revisionConflict.success &&
    revisionConflict.data.reason !== 'missing-hosted-revision'
  )
    return new RecordApiRequestError(
      revisionConflict.data.error,
      'conflict',
      status,
      revisionConflict.data.code,
      false,
      revisionConflict.data.currentRevision,
      revisionConflict.data.reason,
      revisionConflict.data.condition,
    )
  const message = responseMessage(body, recordApiStatus(status))
  if (status === 429) return new RecordApiRequestError(message, 'refused', status)
  if (message === RECORD_ACTIVE_SPACE_REMEDY)
    return new RecordApiRequestError(message, 'refused', status)
  if (
    status === 409 &&
    revisionConflict.success &&
    revisionConflict.data.reason === 'missing-hosted-revision'
  )
    return new RecordApiRequestError(message, 'refused', status)
  if (status >= 400 && status < 500) return new RecordApiRequestError(message, 'refused', status)
  return recordApiServerError(message, status)
}

export function recordAuthToken(headers: Headers, body: unknown): string | null {
  const fromHeader = headers.get('set-auth-token')?.trim()
  if (fromHeader) return fromHeader
  const token = responseRecord(body).token
  return typeof token === 'string' && token.trim() ? token : null
}

export function recordAuthRefusal(status: number, body: unknown, headers: Headers): Error {
  if (status === 401)
    return new RecordApiRequestError(
      `record credentials were refused; ${RECORD_SIGN_IN_REMEDY}`,
      'refused',
    )
  if (status === 429) {
    const interval = headers.get('retry-after') ?? headers.get('x-ratelimit-reset') ?? 'later'
    return new RecordApiRequestError(
      `record sign-in is rate limited; retry after ${interval}`,
      'refused',
    )
  }
  const message = responseMessage(body, recordApiStatus(status))
  if (status >= 400 && status < 500) {
    const code = responseCode(body)
    const existingAccount = code
      ? code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' || code === 'USER_ALREADY_EXISTS'
      : message.startsWith('User already exists')
    return new RecordApiRequestError(message, 'refused', status, code, existingAccount)
  }
  return recordApiServerError(message, status)
}
