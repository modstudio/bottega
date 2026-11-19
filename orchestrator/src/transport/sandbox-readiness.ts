import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  classifySandboxLaunchFailure,
  renderSandboxReadinessRefusal,
  sandboxRuntimeAvailability,
} from '../sandbox/sandbox-runtime.ts'

/** Classify and render one failed sandbox launch without probing successful turns. */
export function sandboxReadinessRefusal(input: {
  srt: boolean
  turnFailed: boolean
  stderr: string
  launchError: string
  originalError?: string
}): string | null {
  const failure = classifySandboxLaunchFailure({
    platform: process.platform,
    sandboxKind: input.srt ? 'srt' : 'host',
    turnFailed: input.turnFailed,
    stderr: input.stderr,
    launchError: input.launchError,
  })
  if (!failure) return null
  return renderSandboxReadinessRefusal(
    failure,
    sandboxRuntimeAvailability(),
    input.originalError ?? input.launchError,
    `${PLATFORM_SLUG} machine doctor`,
  )
}
