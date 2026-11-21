// concern: runtime configuration autoload policy shared by compiled executables.

/** Disable every Bun standalone-executable runtime config loader explicitly. */
export const COMPILED_RUNTIME_AUTOLOAD_DISABLE_FLAGS = [
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig',
  '--no-compile-autoload-tsconfig',
  '--no-compile-autoload-package-json',
] as const
