// concern: record-api-client-outside-intake
/** Owns hosted outside-intake requests. */

import type { RecordClientRequest } from './record-api-client-paths.ts'
import type { OutsideIntake } from './record-outside-intake.ts'

export type RecordOutsideIntakeClient = {
  showOutsideIntake(): Promise<{ intake: OutsideIntake | null }>
  setOutsideIntake(project: string, destinationSpaceId: string): Promise<{ intake: OutsideIntake }>
  pauseOutsideIntake(
    hours: number | undefined,
    destinationSpaceId: string,
  ): Promise<{ intake: OutsideIntake }>
  resumeOutsideIntake(destinationSpaceId: string): Promise<{ intake: OutsideIntake }>
}

export function recordOutsideIntakeClient(request: RecordClientRequest): RecordOutsideIntakeClient {
  return {
    showOutsideIntake: () => request('/v1/outside-intake'),
    setOutsideIntake: (project, destinationSpaceId) =>
      request('/v1/outside-intake', {
        method: 'POST',
        body: JSON.stringify({ project }),
        destinationSpaceId,
      }),
    pauseOutsideIntake: (hours, destinationSpaceId) =>
      request('/v1/outside-intake/pause', {
        method: 'POST',
        body: JSON.stringify(hours === undefined ? {} : { hours }),
        destinationSpaceId,
      }),
    resumeOutsideIntake: (destinationSpaceId) =>
      request('/v1/outside-intake/resume', {
        method: 'POST',
        body: '{}',
        destinationSpaceId,
      }),
  }
}
