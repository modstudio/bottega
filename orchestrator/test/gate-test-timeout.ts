export const CI_TEST_HANG_TIMEOUT_MS = 60_000

export function gateTestTimeoutArguments(ci: boolean): string[] {
  return ci ? [`--timeout=${CI_TEST_HANG_TIMEOUT_MS}`] : []
}
