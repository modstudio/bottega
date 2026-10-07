import { Link } from '@tanstack/react-router'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../../shared/brand.ts'

export const installCommand = `curl -fsSL https://raw.githubusercontent.com/modstudio/${PLATFORM_SLUG}/main/install.sh | sh`
export const Check = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M3 8.5l3.2 3.2L13 5" />
  </svg>
)
function Btn({
  to,
  children,
  ghost = false,
}: {
  to: string
  children: React.ReactNode
  ghost?: boolean
}) {
  return (
    <Link className={`btn${ghost ? ' ghost' : ''}`} to={to}>
      {children}
    </Link>
  )
}
export function Actions({
  secondary,
  primary = `Install ${PLATFORM_NAME}`,
}: {
  secondary?: [string, string]
  primary?: string
}) {
  return (
    <div className="hero-cta">
      <Btn to="/docs">{primary}</Btn>
      {secondary ? (
        <Btn to={secondary[0]} ghost>
          {secondary[1]}
        </Btn>
      ) : null}
    </div>
  )
}
export function Section({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow?: string
  title: string
  intro?: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="wrap">
        <div className="sec-head">
          {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
          <h2>{title}</h2>
          {intro ? <p>{intro}</p> : null}
        </div>
        {children}
      </div>
    </section>
  )
}
export function Cards({
  items,
  columns = 3,
}: {
  items: { eyebrow?: string; title?: string; text?: string }[]
  columns?: 2 | 3 | 4
}) {
  return (
    <div className={`grid g${columns} hover`}>
      {items.map((item) => (
        <div className="cell" key={item.title ?? item.text}>
          {item.eyebrow ? <span className="eyebrow">{item.eyebrow}</span> : null}
          <h3>{item.title}</h3>
          <p>{item.text}</p>
        </div>
      ))}
    </div>
  )
}
export function PageHero({
  crumb,
  title,
  muted,
  copy,
  actions,
}: {
  crumb: string
  title: string
  muted: string
  copy: string
  actions?: [string, string][]
}) {
  return (
    <div className="wrap phero">
      <div className="crumb">
        <span>{PLATFORM_NAME}</span>
        <span>/</span>
        <span>{crumb}</span>
      </div>
      <h1>
        {title}
        <br />
        <em>{muted}</em>
      </h1>
      <p>{copy}</p>
      {actions ? (
        <div className="hero-cta">
          {actions.map(([to, label], i) => (
            <Btn key={`${to}-${label}`} to={to} ghost={i > 0}>
              {label}
            </Btn>
          ))}
        </div>
      ) : null}
    </div>
  )
}
export function Cta({
  title,
  copy,
  actions,
  eyebrow,
  children,
}: {
  title: React.ReactNode
  copy?: string
  actions?: [string, string][]
  eyebrow?: string
  children?: React.ReactNode
}) {
  return (
    <div className="wrap">
      <div className="cta">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h2>{title}</h2>
        {copy ? <p>{copy}</p> : null}
        <div className="hero-cta">
          {(actions ?? [['/docs', `Install ${PLATFORM_NAME}`]]).map(([to, label], i) => (
            <Btn key={`${to}-${label}`} to={to} ghost={i > 0}>
              {label}
            </Btn>
          ))}
        </div>
        {children}
      </div>
    </div>
  )
}
export function Panel({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="eyebrow">{eyebrow}</span>
      </div>
      <div className="panel-body">{children}</div>
    </div>
  )
}
