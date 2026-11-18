import type { OrchProject } from '../../shared/orch-contract.ts'

export type ProjectListOptions = { retired?: boolean }
export type ProjectRegisterReader = (options?: ProjectListOptions) => OrchProject[]

let installedProjectRegisterReader: ProjectRegisterReader | undefined

/** Install the project-register reader preferred by hub reads in this process. */
export function installProjectRegisterReader(reader: ProjectRegisterReader): void {
  installedProjectRegisterReader = reader
}

/** Return the installed reader when the owning entrypoint supplied one. */
export function projectRegisterReader(): ProjectRegisterReader | undefined {
  return installedProjectRegisterReader
}
