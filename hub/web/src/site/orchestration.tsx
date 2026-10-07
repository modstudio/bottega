import { Cards, Cta, PageHero, Section } from './shared'

const mechanism = [
  {
    eyebrow: 'Stop',
    title: 'A question suspends the run',
    text: 'A worker that reaches a judgment call it was not given stops there. The run is preserved, not restarted, so asking costs almost nothing.',
  },
  {
    eyebrow: 'Score',
    title: 'Asking is faithful',
    text: 'A worker that stopped is never marked down for stopping. Penalize the question and workers learn to guess instead — which is the failure the contract exists to prevent.',
  },
  {
    eyebrow: 'Judge',
    title: 'Fidelity is scored apart',
    text: 'Correct, tested code that solved a different problem is still a failure. That axis is judged on its own, on the four writing jobs.',
  },
  {
    eyebrow: 'Isolation',
    title: 'One worktree per run',
    text: 'A disposable checkout bounds what an agent can touch, and the run that provisions it releases it.',
  },
  {
    eyebrow: 'Review',
    title: 'Review is one question at a time',
    text: 'Each pass answers one named question. How many passes run is fixed up front, so review cannot balloon.',
  },
  {
    eyebrow: 'Recovery',
    title: 'Nothing runs unwatched',
    text: 'A heartbeat reports blocked, waiting or clear, so a stalled run is never mistaken for a working one.',
  },
]

export function OrchestrationPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Orchestration"
        title="Delegate the execution."
        muted="Never the judgment."
        copy="A change is decisions plus typing. The architect owns what the change means, which ambiguity resolves which way, and what must stay true. A worker owns the typing — and is contractually forbidden from deciding anything it was not given."
        actions={[
          ['/docs', 'Run your first job'],
          ['/product/workers', 'See the hierarchy'],
        ]}
      />
      <Section title="Spec, build, rule, judge">
        <Cards
          items={[
            {
              eyebrow: '01',
              title: 'You write the spec',
              text: "The architect designs the change and rules on what it means. Your project rules, the job contract and the retrieval context are compiled into the worker's prompt automatically.",
            },
            {
              eyebrow: '02',
              title: 'A worker builds it',
              text: 'One disposable worktree per run. The worker cannot push, cannot widen scope, and cannot resolve an ambiguity — it stops and asks. Asking is not a failure; it is how a worker stays faithful.',
            },
            {
              eyebrow: '03',
              title: 'You rule, it resumes',
              text: 'Answer the question and the run continues from where it stopped, with your ruling in hand.',
            },
            {
              eyebrow: '04',
              title: 'You judge, routing learns',
              text: 'Read the diff and score it — correctness separately from fidelity. After enough scored runs the job routes by measured success on your repositories, not by reputation.',
            },
          ]}
        />
      </Section>
      <hr className="site-divider" />
      <Section
        eyebrow="The mechanism"
        title="Why a worker never guesses"
        intro="Three parts carry the load. Remove any one and delegation starts costing more than it saves."
      >
        <Cards items={mechanism} />
      </Section>
      <Cta
        title={
          <>
            Your first run
            <br />
            takes one command.
          </>
        }
      />
    </main>
  )
}
