// Checked against Bun 1.4.5 help (shipped binaries embed Bun 1.4.4) and
// https://bun.com/docs/compiler/executables. BUN_OPTIONS and BUN_BE_BUN are deliberately
// excluded: they come from the caller's environment, whose controller already controls the process.
export const COMPILE_AUTOLOAD_OFF_FLAGS = [
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig',
  '--no-compile-autoload-tsconfig',
  '--no-compile-autoload-package-json',
] as const
