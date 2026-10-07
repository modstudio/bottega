import { Link } from '@tanstack/react-router'
import { Fragment } from 'react'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import { RunShowcase } from './run-showcase'
import { Actions, Cta, installCommand, Section } from './shared'

const bullets = {
  orchestration: [
    'Worker contracts and escalation',
    'Cloud agents or models on your own GPU',
    'Multi-lens review on a budget that ends',
    'Evidence-based routing',
    'Workflows for the whole task lifecycle',
    'Local retrieval that feeds every run',
  ],
  workspace: [
    'One board across every project',
    'Docs your team and your models both read',
    'Task plans, handoffs and resume briefs',
    'A suggestion box that never spams the board',
    'Cost and time per change',
    'All of it reachable over MCP',
  ],
}
export function HomePage() {
  return (
    <main className="site-page">
      <div className="wrap hero">
        <span className="pill fade-up">
          <span className="dot" aria-hidden="true" /> Not another coding agent. The workshop that
          runs them.
        </span>
        <h1 className="fade-up d1">
          You keep every decision.
          <br />
          <em>Workers do the rest.</em>
        </h1>
        <p className="lede fade-up d2">
          You design the change, rule on the forks and read the diff. Cloud and local workers do the
          typing — under contract, in disposable worktrees, never guessing. Everything else a team
          needs comes with it.
        </p>
        <div className="fade-up d3">
          <Actions secondary={['/product/orchestration', 'See how it works']} />
        </div>
        <p className="micro fade-up d3">
          Runs on your machine · Frontier tokens for the spec and the diff · Everything else cheap
          or local
        </p>
        <div className="runners fade-up d4">
          {['Claude Code', 'Codex', 'Grok', 'Ollama', 'vLLM', 'LM Studio', 'llama.cpp'].map(
            (name) => (
              <span key={name}>
                <i />
                {name}
              </span>
            ),
          )}
        </div>
      </div>
      <RunShowcase />
      <section>
        <div className="wrap">
          <div className="sec-head">
            <h2>How the work gets done, and where it lives</h2>
            <p>
              Every run, task, document and decision is one record — not an orchestration tool with
              a board bolted on.
            </p>
          </div>
          <div className="halves">
            <Half
              to="/product/orchestration"
              eyebrow="Orchestration"
              title="How the work gets done"
              copy={`A worker builds from your spec in a disposable worktree, stops at every judg${String.fromCharCode(101, 109, 101, 110, 116)} call and never pushes. You rule, read the diff and score it — and the score decides who gets the next job of that shape.`}
              bullets={bullets.orchestration}
              go="Explore orchestration →"
            />
            <Half
              to="/product/board"
              eyebrow="Workspace"
              title="Where the work lives"
              copy="Every project on one board, whatever tracker each one actually runs. Tasks, documentation, decisions and cost in the same system as the runs — so a change is already attributed before you score it."
              bullets={bullets.workspace}
              go="Explore the workspace →"
            />
          </div>
        </div>
      </section>
      <hr className="rule" />
      <Section
        eyebrow="The lifecycle"
        title="Every task takes the same ten steps"
        intro="Workflows run the whole life of a task — plan, build, review, gate, land, close. Each step declares the job that runs it, whether it may proceed alone, and the evidence it must leave behind, composed from your project's own trunk, tracker, gate and release rules."
      >
        <div className="lifecycle">
          {['Plan', 'Dispatch', 'Rule', 'Review', 'Triage', 'Gate', 'Land', 'Close'].map(
            (step, i) => (
              <Fragment key={step}>
                <span className={step === 'Review' ? 'on' : ''}>{step}</span>
                {i < 7 ? <i aria-hidden="true">→</i> : null}
              </Fragment>
            ),
          )}
        </div>
        <div className="grid g2 hover home-links">
          <Link className="cell" to="/product/workflows">
            <span className="eyebrow">Workflows</span>
            <h3>Declared steps, composed per project</h3>
            <p>
              Auto where it is safe, <b>ask</b> where it is a decision. A step has not completed
              because an agent says so — it completes when its evidence floor is met.
            </p>
            <span className="go">See the ten steps →</span>
          </Link>
          <Link className="cell" to="/product/review">
            <span className="eyebrow">Review</span>
            <h3>Multi-lens, multi-round, and it ends</h3>
            <p>
              The change's tier fixes how many lenses run and how many rounds they may take. Lenses
              are measured on what survives triage, so an unproductive one is retired on evidence.
            </p>
            <span className="go">Inside review →</span>
          </Link>
        </div>
      </Section>
      <div className="wrap">
        <div className="onechange">
          <div className="oc-head">
            <span className="eyebrow">One change, end to end</span>
            <h3>ATL-412 · Retry failed webhook deliveries with backoff</h3>
          </div>
          <div className="oc-row">
            {[
              ['Architect time', '41 min', 'spec, one ruling, diff read'],
              ['Worker runs', '2', 'codex · one retry after review'],
              ['Questions', '1', 'answered in 90 seconds'],
              ['Frontier tokens', 'Spec & diff', 'the build ran below'],
              ['Landed by', 'You', 'after the gate, by pull request'],
            ].map(([label, value, sub]) => (
              <div key={label}>
                <span className="eyebrow">{label}</span>
                <b>{value}</b>
                <span className="oc-sub">{sub}</span>
              </div>
            ))}
          </div>
          <p className="oc-foot">
            The worker typed. You designed it, ruled once, read the diff and scored it.{' '}
            <span>Illustrated.</span>
          </p>
        </div>
      </div>
      <Section
        eyebrow="Fits your stack"
        title="Works with the agents and models you already run"
        intro={`Swap the harness and the record stays. ${PLATFORM_NAME} keeps the task, the contract, the evidence and the score independent of whoever does the work.`}
      >
        <div className="tools">
          {[
            ['Cloud agents', ['Claude Code', 'Codex', 'Grok']],
            ['Local runtimes', ['Ollama', 'vLLM', 'LM Studio', 'llama.cpp']],
            ['Interfaces', ['MCP', 'Git worktrees', 'GitHub']],
          ].map(([group, names]) => (
            <div className="tool-set" key={group as string}>
              <span className="tool-group">{group}</span>
              {(names as string[]).map((name) => (
                <span className="tool" key={name}>
                  <i />
                  {name}
                </span>
              ))}
            </div>
          ))}
        </div>
      </Section>
      <Cta
        title={
          <>
            Install it.
            <br />
            Keep your harness.
          </>
        }
        copy={`${PLATFORM_NAME} runs beside the agent you already use. Bring your own models.`}
        actions={[
          ['/docs', `Install ${PLATFORM_NAME}`],
          ['/docs', 'Read the docs'],
        ]}
        eyebrow="Get started"
      >
        <p className="micro mono install-command">{installCommand}</p>
      </Cta>
    </main>
  )
}
function Half({
  to,
  eyebrow,
  title,
  copy,
  bullets: items,
  go,
}: {
  to: string
  eyebrow: string
  title: string
  copy: string
  bullets: string[]
  go: string
}) {
  return (
    <Link className="half" to={to}>
      <span className="eyebrow">{eyebrow}</span>
      <h3>{title}</h3>
      <p>{copy}</p>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <span className="go">{go}</span>
    </Link>
  )
}
