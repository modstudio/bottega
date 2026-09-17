export type Report = {
  enabled: boolean
  to: string[]
  fromName: string
  fromAddress: string
  subjectPrefix: string
  smtpHost: string
  smtpPort: number
  smtpUser: string
  /** `keychain:<service>` or `env:<NAME>`. Never the secret itself. */
  smtpPasswordRef: string
  /** Hours the report covers. */
  windowHours: number
  /**
   * Below this much engaged time, the report is not sent.
   *
   * Measured on engaged time rather than conversation time: work-report's guard
   * counted only Claude's own message gaps, so a day of heavy delegation or of
   * tracker and commit work could fall under the bar and silently skip.
   */
  minMinutes: number
  /**
   * Which projects the EMAIL covers. The dashboard is always all five; the
   * report is a subset, and that difference is the reason this is a setting
   * rather than a constant.
   */
  projects: string[]
  /**
   * Per-initiative context for the summariser, and work to leave out.
   *
   * `match` is case-insensitive substrings tested against a task's key and
   * title. `brief` is stakes the summariser cannot infer from a title - that a
   * migration exists because the framework is end-of-life, say. `exclude` drops
   * matched work from the report entirely, which is how internal review work
   * stays out of a stakeholder's inbox without stopping being measured.
   */
  briefs: Brief[]
  /**
   * Where a TEST send goes.
   *
   * Its own field so the real recipient list can stay set to whoever should get
   * the daily report while it is being changed. Editing `to` down to one address
   * to try something, and remembering to put it back, is how a colleague stops
   * receiving a report nobody notices has stopped.
   */
  testTo: string
}

export type Brief = {
  name: string
  match: string[]
  brief?: string
  exclude?: boolean
}
