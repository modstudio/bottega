// concern: runtime configuration autoload policy shared by compiled executables.

/**
 * Disable every Bun standalone-executable runtime config loader explicitly.
 *
 * This list is checked against Bun 1.4.5 `bun build --help` and
 * https://bun.com/docs/compiler/executables. Every switch is set off explicitly,
 * including loaders that default off, so a Bun upgrade cannot turn one back on.
 * BUN_OPTIONS and BUN_BE_BUN are deliberately out of scope: they come from the
 * caller's environment, and whoever controls that already controls the process.
 */
export const COMPILED_RUNTIME_AUTOLOAD_DISABLE_FLAGS = [
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig',
  '--no-compile-autoload-tsconfig',
  '--no-compile-autoload-package-json',
] as const
