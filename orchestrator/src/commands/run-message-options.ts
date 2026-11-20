// concern: cli
/** Registers answer, retry, and continue options without owning their actions. */

import type { Command } from 'commander'
import { describedCommand } from './support.ts'

const withKeyedTurnOverride = (command: Command): Command =>
  command
    .option('--override-unbound <reason>', 'override keyed cursor admission')
    .option('--from-operator', 'attest that a person, not an agent, requested the override')

export const answerCommandDefinition = (program: Command): Command =>
  describedCommand(
    program,
    'answer <id> [message...]',
    'record rulings for a worker and resume its run',
  )
    .allowUnknownOption(true)
    .option('--file <value>', 'read the ruling from this file')
    .option('--value <value>', 'record the typed value of the ruling')
    .option('--follow', 'wait for the resumed run and print its result')
    .option('--detach', 'return after resuming the run')
    .option('--quiet', 'suppress collection guidance and followed output')
    .option('--record-only', 'record the ruling without resuming the run')
    .option('--from-operator', 'attribute the ruling to the operator')
    .option('--from-operator-q<id>', 'attribute only question <id> to the operator')
    .option('--channel <value>', 'record the channel that supplied the ruling')
    .option('--json', 'write the answer result as JSON')

export const retryCommandDefinition = (program: Command): Command =>
  withKeyedTurnOverride(
    describedCommand(program, 'retry <id>', 'retry a failed run with its saved prompt')
      .option('--agent <value>', 'use this agent for the retry')
      .option('--model <value>', 'use this model for the retry')
      .option('--follow', 'wait for the retry and print its result')
      .option('--detach', 'return after starting the retry')
      .option('--quiet', 'suppress collection guidance and followed output'),
  ).allowExcessArguments(false)

export const continueCommandDefinition = (program: Command): Command =>
  withKeyedTurnOverride(
    describedCommand(
      program,
      'continue <id> [message...]',
      'continue a finished run as another turn',
    )
      .allowUnknownOption(true)
      .option('--file <value>', 'read the continuation message from this file')
      .option('--follow', 'wait for the continuation and print its result')
      .option('--detach', 'return after starting the continuation')
      .option('--quiet', 'suppress collection guidance and followed output')
      .option('--cursor <number>', 'select the held workflow cursor for this keyed continuation')
      .option('--findings', 'include prior review findings in the continuation'),
  )
