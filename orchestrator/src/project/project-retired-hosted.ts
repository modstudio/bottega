// concern: project-retired-hosted
/** Owns the shared refusal for adopting a retired hosted project namesake. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export function retiredHostedProjectMessage(name: string): string {
  return `hosted project ${name} is retired in the space; unretire it from a machine that holds it with ${PLATFORM_SLUG} project retire ${name} --undo, then run ${PLATFORM_SLUG} project relink ${name} here`
}
