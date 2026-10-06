import { Cards, Cta, PageHero, Section } from './shared'

export function WorkflowsPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Workflows"
        title="One lifecycle."
        muted="Every task, every project."
        copy="A workflow is a named sequence of steps, and each step declares the job that runs it, whether it may proceed on its own, and the evidence it must produce before the next step starts. Your project's own facts — trunk, tracker, gate, release rules — are composed in when the workflow is requested, so the same lifecycle behaves correctly in every repository without being rewritten for each one."
        actions={[
          ['/docs', 'Read the workflow guide'],
          ['/product/board', 'See the board'],
        ]}
      />
      <Section
        eyebrow="Why it is predictable"
        title="The step declares what it needs, not how you feel about it"
        intro="Three declarations per step remove the guesswork that makes agent workflows drift: what runs it, whether it may proceed alone, and what it must leave behind."
      >
        <Cards
          items={[
            {
              eyebrow: 'Job',
              title: 'Who does the work',
              text: 'A step either names an orch job and routes by scored evidence, or it is a plain command the step runs itself.',
            },
            {
              eyebrow: 'Autonomy',
              title: 'Whether it may proceed',
              text: 'Auto runs and continues. Ask stops and waits for you. Triage, applying findings, opening, merging and promoting all stop — because each is a decision.',
            },
            {
              eyebrow: 'Evidence floor',
              title: 'What it must leave behind',
              text: 'A command exit, a recorded artifact, a human ruling, or a tracker transition.',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Composition"
        title="The same workflow, correct in every project"
        intro="A workflow is composed on request: the steps come from the catalogue, and the project register supplies the facts — which branch is trunk, which tracker holds the task, which gate proves a commit, how releases merge."
      >
        <Cards
          items={[
            { title: 'One catalogue', text: 'Versioned and shared by every project.' },
            {
              title: 'Project facts',
              text: 'Resolved at compose time, never hardcoded in a prompt.',
            },
            {
              title: 'Modes',
              text: 'Select how far to go — plan only, review only, ship and promote.',
            },
          ]}
        />
      </Section>
      <Section eyebrow="The catalogue" title="A workflow for each shape of work">
        <Cards
          items={[
            {
              eyebrow: 'Before',
              title: 'Plan a task',
              text: 'Turn an intent into a specification a worker could build against.',
            },
            {
              eyebrow: 'During',
              title: 'Fix a defect',
              text: 'Diagnose first, then change one thing.',
            },
            {
              eyebrow: 'During',
              title: 'Review code',
              text: 'Independent lenses under a fixed round budget.',
            },
            {
              eyebrow: 'After',
              title: 'Ship a task',
              text: 'Rebase, review, triage, gate, open, merge, promote, close.',
            },
            {
              eyebrow: 'Anytime',
              title: 'Report an issue',
              text: 'File a defect with reproduction, environment and what is not established.',
            },
            {
              eyebrow: 'Upkeep',
              title: 'Sync the docs',
              text: 'Bring the doc store and the tree back into agreement.',
            },
          ]}
        />
      </Section>
      <Cta
        title={
          <>
            Same lifecycle.
            <br />
            Every repository.
          </>
        }
      />
    </main>
  )
}
