/** One-shot copy-on-write directory cloning on platforms that provide clonefile(2). */
import { platform } from 'node:os'
import { type CloneDirectoryOutcome, classifyClonefileErrno } from './clone-directory-outcome.ts'

type ClonefileLibrary = ReturnType<typeof loadClonefileLibrary>
let clonefileLibrary: ClonefileLibrary | undefined

/** Preserve a top-level source symlink instead of following it. From <sys/clonefile.h>. */
const CLONE_NOFOLLOW = 1

function loadClonefileLibrary() {
  const { dlopen, FFIType, toArrayBuffer } = require('bun:ffi') as typeof import('bun:ffi')
  const library = dlopen('/usr/lib/libSystem.dylib', {
    clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  })
  return {
    clonefile: library.symbols.clonefile,
    errno: () => {
      const pointer = library.symbols.__error()
      if (pointer === null) throw new Error('clonefile failed but __error returned null')
      return new Int32Array(toArrayBuffer(pointer, 0, 4))[0]!
    },
  }
}

/** Clone a directory in one syscall, without loading the Darwin FFI elsewhere. */
export function cloneDirectory(source: string, target: string): CloneDirectoryOutcome {
  if (platform() !== 'darwin') {
    return { status: 'unsupported', errno: null, errnoName: null }
  }
  clonefileLibrary ??= loadClonefileLibrary()
  const result = clonefileLibrary.clonefile(
    Buffer.from(`${source}\0`),
    Buffer.from(`${target}\0`),
    CLONE_NOFOLLOW,
  )
  if (result === 0) return { status: 'cloned' }
  return classifyClonefileErrno(clonefileLibrary.errno())
}
