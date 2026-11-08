---
description: Typed questions, the cheap TypeSafe judgments, and how they are added and measured.
paths:
  - orchestrator/src/typed-question/*.ts
  - orchestrator/src/collect/finding-duplicate-suggestions.ts
  - hub/src/note-duplicate-question.ts
  - shared/typed-question/*.ts
  - orchestrator/src/ask/jev-*.ts
  - orchestrator/src/ask/worker-question.ts
---

# Typed questions

A typed question is one fixed recognition judgment asked of TypeSafe and recorded with its subject, so a later outcome can grade it. The how-to is the doc-store article `typed-questions`.

**An answer only advises.** It may warn or suggest; it never blocks, refuses or decides. `askTypedQuestion` fails open: a missing `TYPESAFE_KEY` or any failure returns no answer, and a missing key records nothing.

**A worker's escalation question is the one exception, and it is gated.** Jev pre-answers it through the shared client and shows its pick and probabilities beside the question. It rules only on the live channel with `jev.auto_rule` on, rulings autonomy `agent` and the pick's probability at or above `jev.confidence_threshold` (`orchestrator/src/ask/jev-routing.ts:routeJevAnswer`); a choice also needs both option orders to agree and the companion fit at or above `jev.fit_threshold`. Everything else escalates.

Jev's state carries the run's spec, and a worker's questions share one request.

Turn `jev.auto_rule` on only after `jev_agreed`, reported by `bottega agent typed-question`, shows the threshold is reliable. A failed pre-answer stores `jev_error` and never blocks escalation.

An architect's answer to a typed question records its value, inferred from a leading option name or given with `--value`; a ruling that starts with `None:`, or `--value none` with an explanation, records that no option fits.

**A question needs a label before it may change behavior.** Its label is a recorded outcome that settles whether an answer was right, such as `specUnsettledLabel` or `findingDuplicateLabel`. A question with no label is measured by nothing, so it is not built.

**A version with answers is frozen.** Changed instructions, context or threshold make a new version. Older versions stay declared in `TYPED_QUESTION_DECLARATIONS` so reports and backtests can read their answers.

**A version reaches live use only after its backtest beats the incumbent** by more than its added cost, on the same subjects. A question with no backtest source, such as `NOTE_DUPLICATE_QUESTION`, is judged on its live answers. `DISPATCH_SPEC_QUESTIONS` lists the spec versions dispatch asks; `SPEC_UNSETTLED_QUESTION` is the one that warns. `bottega agent typed-question backtest` measures a version; `bottega agent typed-question` reports live answers.

**A backtest reads cited files at each run's base commit.** A run whose commit is missing from the checkout counts as unreadable and is never asked without its context.
