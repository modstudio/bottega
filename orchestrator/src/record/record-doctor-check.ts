// concern: record-doctor-check
/** Shared presentation contract for one record doctor check. */

type RecordDoctorStatus = 'pass' | 'fail' | 'skipped'

export type RecordDoctorCheck = {
  name: string
  status: RecordDoctorStatus
  detail?: string
  section?: 'customer' | 'operator'
}
