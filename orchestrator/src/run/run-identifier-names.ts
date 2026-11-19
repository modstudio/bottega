// concern: run-control
/** Applies this machine's current and former names to the pure run identifier grammar. */

import { storedMachineNames } from '../../../shared/machine-config.ts'
import {
  classifyRunIdentifier as classifyGrammar,
  parseRunIdentifier as parseGrammar,
} from './run-identifier-grammar.ts'

function machineNamesFor(input: string | number) {
  return typeof input === 'string' && input.includes('/') ? storedMachineNames() : null
}

export const classifyRunIdentifier = (input: string | number) =>
  classifyGrammar(input, machineNamesFor(input))

export const parseRunIdentifier = (input: string | number) =>
  parseGrammar(input, machineNamesFor(input))
