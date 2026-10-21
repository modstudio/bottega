import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const typescript = process.env.ARCHITECTURE_TYPESCRIPT

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'typescript' && typescript) {
      return { url: pathToFileURL(typescript).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
