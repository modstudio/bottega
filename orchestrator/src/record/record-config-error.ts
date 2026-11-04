// concern: hosted-config-refusals
/** The typed refusal shared by hosted-config services and API error rendering. */
export class ConfigServiceError extends Error {
  status: 403 | 404 | 409 | 422
  constructor(message: string, status: 403 | 404 | 409 | 422) {
    super(message)
    this.status = status
  }
}
