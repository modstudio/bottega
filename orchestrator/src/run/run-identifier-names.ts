// concern: run-control
/** Applies this machine's current and former names to the pure run identifier grammar. */

import { storedMachineNames } from '../../../shared/machine-config.ts'
import {
  classifyRunIdentifier as classifyGrammar,
  parseRunIdentifier as parseGrammar,
} from './run-identifier-grammar.ts'

function machineIdentifierNames() {
  const stored = storedMachineNames()
  return stored
    ? { shortName: stored.shortName, formerShortNames: stored.formerShortNames ?? [] }
    : null
}

export const classifyRunIdentifier = (input: string | number) =>
  classifyGrammar(input, machineIdentifierNames())

export const parseRunIdentifier = (input: string | number) =>
  parseGrammar(input, machineIdentifierNames())
