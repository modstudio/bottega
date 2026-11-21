// concern: compile marked checkout executables with runtime configuration autoload disabled.

import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { COMPILED_RUNTIME_AUTOLOAD_DISABLE_FLAGS } from '../../../shared/compiled-runtime-autoload.ts'
import { INSTALL_HOME_ENV } from '../../../shared/install-root.ts'
import type { StateEnvironment } from '../../../shared/state-directory.ts'

/** Compile one marked checkout executable with every runtime config loader disabled. */
export function compileCheckoutCliEntry(
  checkoutRoot: string,
  entry: string,
  outfile: string,
  environment: StateEnvironment = process.env,
) {
  return startBoundedSync(
    [
      'bun',
      'build',
      '--compile',
      ...COMPILED_RUNTIME_AUTOLOAD_DISABLE_FLAGS,
      '--define',
      'BOTTEGA_COMPILED_CHECKOUT_BUILD=true',
      entry,
      '--outfile',
      outfile,
    ],
    {
      budget: 'machine-update',
      cwd: checkoutRoot,
      env: { ...environment, [INSTALL_HOME_ENV]: checkoutRoot },
    },
  )
}
