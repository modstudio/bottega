import { isDatabaseLocked } from '../../shared/database-lock-refusal.ts'

export function applyHostedWriteLocally(message: string, apply: () => void): boolean {
  try {
    apply()
    return true
  } catch (error) {
    if (!isDatabaseLocked(error)) throw error
    console.error(message)
    return false
  }
}
