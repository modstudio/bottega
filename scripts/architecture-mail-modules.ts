// concern: architecture-manifest
/** Mail module allowlists, kept beside the root manifest so it stays within its file ceiling. */

import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const mailModules: ArchitectureModule[] = [
  module('orchestrator/src/mail/password-reset-mailer.ts', [
    '../../../shared/brand.ts',
    './ses-mailer.ts',
  ]),
  module('orchestrator/src/mail/email-verification-mailer.ts', [
    '../../../shared/brand.ts',
    './ses-mailer.ts',
  ]),
  module('orchestrator/src/mail/ses-mailer.ts', ['@aws-sdk/client-sesv2']),
  module('orchestrator/src/mail/invitation-mailer.ts', [
    '@aws-sdk/client-sesv2',
    '../../../shared/brand.ts',
  ]),
]
