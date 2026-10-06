import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import { RunShowcase } from './run-showcase'
import { Actions, Cards, Cta, installCommand, Section } from './shared'

export function HomePage() {
  return (
    <main className="site-page">
      <div className="site-wrap site-hero">
        <span className="site-pill">Not another coding agent. The workshop that runs them.</span>
        <h1>
          You keep every decision.
          <br />
          <em>Workers do the rest.</em>
        </h1>
        <p className="site-lede">
          You design the change, rule on the forks and read the diff. Cloud and local workers do the
          typing — under contract, in disposable worktrees, never guessing. Everything else a team
          needs comes with it.
        </p>
        <Actions secondary={['/product/orchestration', 'See how it works']} />
        <p className="site-micro">
          Runs on your machine · Frontier tokens for the spec and the diff · Everything else cheap
          or local
        </p>
        <div className="site-runners">
          <span>Claude Code</span>
          <span>Codex</span>
          <span>Grok</span>
          <span>Ollama</span>
          <span>vLLM</span>
          <span>LM Studio</span>
          <span>llama.cpp</span>
        </div>
      </div>
      <RunShowcase />
      <Section
        title="How the work gets done, and where it lives"
        intro="Every run, task, document and decision is one record — not an orchestration tool with a board bolted on."
      >
        <Cards
          two
          items={[
            {
              eyebrow: 'Orchestration',
              title: 'How the work gets done',
              text: 'A worker builds from your spec in a disposable worktree, stops at every judgment call and never pushes. You rule, read the diff and score it — and the score decides who gets the next job of that shape.',
              bullets: [
                'Worker contracts and escalation',
                'Cloud agents or models on your own GPU',
                'Multi-lens review on a budget that ends',
                'Evidence-based routing',
                'Workflows for the whole task lifecycle',
                'Local retrieval that feeds every run',
              ],
              to: '/product/orchestration',
            },
            {
              eyebrow: 'Workspace',
              title: 'Where the work lives',
              text: 'Every project on one board, whatever tracker each one actually runs. Tasks, documentation, decisions and cost in the same system as the runs — so a change is already attributed before you score it.',
              bullets: [
                'One board across every project',
                'Docs your team and your models both read',
                'Task plans, handoffs and resume briefs',
                'A suggestion box that never spams the board',
                'Cost and time per change',
                'All of it reachable over MCP',
              ],
              to: '/product/board',
            },
          ]}
        />
      </Section>
      <hr className="site-divider" />
      <Section
        eyebrow="The lifecycle"
        title="Every task takes the same ten steps"
        intro="Workflows run the whole life of a task — plan, build, review, gate, land, close. Each step declares the job that runs it, whether it may proceed alone, and the evidence it must leave behind, composed from your project's own trunk, tracker, gate and release rules."
      >
        <div className="site-panel site-code">
          Plan → Dispatch → Rule → Review → Triage → Gate → Land → Close
        </div>
        <Cards
          two
          items={[
            {
              eyebrow: 'Workflows',
              title: 'Declared steps, composed per project',
              text: 'Auto where it is safe, ask where it is a decision. A step has not completed because an agent says so — it completes when its evidence floor is met.',
              to: '/product/workflows',
            },
            {
              eyebrow: 'Review',
              title: 'Multi-lens, multi-round, and it ends',
              text: "The change's tier fixes how many lenses run and how many rounds they may take. Lenses are measured on what survives triage, so an unproductive one is retired on evidence.",
              to: '/product/review',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Fits your stack"
        title="Works with the agents and models you already run"
        intro={`Swap the harness and the record stays. ${PLATFORM_NAME} keeps the task, the contract, the evidence and the score independent of whoever does the work.`}
      >
        <div className="site-runners">
          <span>Claude Code</span>
          <span>Codex</span>
          <span>Grok</span>
          <span>Ollama</span>
          <span>vLLM</span>
          <span>LM Studio</span>
          <span>llama.cpp</span>
          <span>MCP</span>
          <span>Git worktrees</span>
          <span>GitHub</span>
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
      />
      <p className="site-code site-micro site-wrap" style={{ textAlign: 'center' }}>
        {installCommand}
      </p>
    </main>
  )
}
