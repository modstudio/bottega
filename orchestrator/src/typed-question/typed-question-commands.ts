// concern: typed-question-commands
/** Presents typed-question measurements. Must not know CLI grammar. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { typedQuestionDays } from '../../../shared/typed-question/typed-question-blocks.ts'
import {
  formatMetricValue,
  renderTypedQuestionBlock,
} from '../../../shared/typed-question/typed-question-render.ts'
import type { JevWorkerQuestionMetrics } from './jev-worker-question-report.ts'
import { jevWorkerQuestionReport } from './jev-worker-question-report-reader.ts'
import { backtestLimit, typedQuestionBacktest } from './typed-question-backtest.ts'
import { typedQuestionReport } from './typed-question-report.ts'

type Presentation = { log(value: string): void }

function renderJevWorkerQuestions(
  report: readonly JevWorkerQuestionMetrics[],
  presentation: Presentation,
): void {
  presentation.log('\nJev worker questions')
  if (!report.length) {
    presentation.log('  no advised worker questions recorded')
    return
  }
  for (const block of report) {
    const heading =
      block.kind === 'all'
        ? 'all versions'
        : `${block.kind} ${block.model ?? 'model none'} version ${block.version}`
    presentation.log(`  ${heading}`)
    presentation.log(
      `    advised ${block.advised}; ruledByArchitect ${block.ruledByArchitect}; agreed ${block.agreed}; agreementRate ${formatMetricValue(block.agreementRate)}; unreadable ${block.unreadable}`,
    )
    presentation.log(
      `    threshold ${block.threshold}; coverage ${formatMetricValue(block.coverage)}; agreementAtThreshold ${formatMetricValue(block.agreementAtThreshold)}; brier ${formatMetricValue(block.brier)}`,
    )
    presentation.log(
      `    orderFlipped ${block.orderFlipped}; fitAtOrAbove ruled ${block.fitAtOrAbove.ruled} agreementRate ${formatMetricValue(block.fitAtOrAbove.agreementRate)}; fitBelow ruled ${block.fitBelow.ruled} agreementRate ${formatMetricValue(block.fitBelow.agreementRate)}`,
    )
    presentation.log(
      `    bands ${block.bands.map((band) => `${band.range} ${band.n}/${formatMetricValue(band.agreementRate)}`).join('; ')}`,
    )
  }
}

export function typedQuestionCommand(
  options: { question?: string; days?: string; job?: string; json: boolean },
  presentation: Presentation,
): void {
  const days = typedQuestionDays(options.days)
  const report = typedQuestionReport({ question: options.question, days, job: options.job })
  const jevWorkerQuestions =
    options.question || options.job ? null : jevWorkerQuestionReport({ days })
  if (options.json) {
    presentation.log(JSON.stringify({ typedQuestions: report, jevWorkerQuestions }, null, 2))
    return
  }
  if (!report.length) {
    const filters = [
      options.question ? `question ${options.question}` : null,
      days !== undefined ? `the last ${days} day(s)` : null,
    ].filter(Boolean)
    presentation.log(
      filters.length
        ? `no typed-question answers recorded for ${filters.join(' in ')}; run without the filter to see every recorded question`
        : `no typed-question answers recorded — record them with: ${PLATFORM_SLUG} run start implement`,
    )
  } else {
    for (const block of report) renderTypedQuestionBlock(block, presentation)
  }
  if (jevWorkerQuestions) renderJevWorkerQuestions(jevWorkerQuestions, presentation)
}

export async function typedQuestionBacktestCommand(
  options: { question?: string; version?: string; job?: string; limit?: string; project?: string },
  presentation: Presentation,
): Promise<void> {
  if (!options.question) throw new Error('--question is required for backtest')
  const version = Number(options.version)
  if (!options.version || !Number.isSafeInteger(version) || version < 1)
    throw new Error('--version must be a positive integer')
  await typedQuestionBacktest(
    {
      question: options.question,
      version,
      job: options.job,
      limit: backtestLimit(options.limit),
      project: options.project,
    },
    presentation,
  )
}
