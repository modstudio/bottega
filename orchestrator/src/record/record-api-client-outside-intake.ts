// concern: record-api-client-outside-intake
/** Owns hosted outside-intake requests. */

import type { RecordClientRequest } from './record-api-client-paths.ts'
import type { OutsideIntake } from './record-outside-intake.ts'

export type RecordOutsideIntakeClient = {
  showOutsideIntake(): Promise<{ intake: OutsideIntake | null }>
  setOutsideIntake(project: string): Promise<{ intake: OutsideIntake }>
  pauseOutsideIntake(hours?: number): Promise<{ intake: OutsideIntake }>
  resumeOutsideIntake(): Promise<{ intake: OutsideIntake }>
}

export function recordOutsideIntakeClient(request: RecordClientRequest): RecordOutsideIntakeClient {
  return {
    showOutsideIntake: () => request('/v1/outside-intake'),
    setOutsideIntake: (project) =>
      request('/v1/outside-intake', {
        method: 'POST',
        body: JSON.stringify({ project }),
      }),
    pauseOutsideIntake: (hours) =>
      request('/v1/outside-intake/pause', {
        method: 'POST',
        body: JSON.stringify(hours === undefined ? {} : { hours }),
      }),
    resumeOutsideIntake: () => request('/v1/outside-intake/resume', { method: 'POST', body: '{}' }),
  }
}
