import { ProjectName } from '@bottega/hub-ui/project-mark'
import { PROJECT_FALLBACK } from '@bottega/hub-util/project'
import { type CSSProperties, createContext, useContext } from 'react'

export type ProjectColors = Record<string, { light: string | null; dark: string | null }>
export const ProjectColorsContext = createContext<ProjectColors>({})

export function projectVars(
  colors: ProjectColors,
  name: string | null | undefined,
): CSSProperties | undefined {
  const c = name ? colors[name] : undefined
  if (!c?.light) return undefined
  return { '--project-light': c.light, '--project-dark': c.dark ?? c.light } as CSSProperties
}

/** A project name with its color bar; "elsewhere" when the row has none. */
export function ProjectMark({
  name,
  colors: suppliedColors,
}: {
  name: string | null | undefined
  colors?: ProjectColors
}) {
  const contextColors = useContext(ProjectColorsContext)
  const colors = suppliedColors ?? contextColors
  const color = name ? colors[name] : undefined
  return (
    <ProjectName name={name || PROJECT_FALLBACK} color={color?.light} colorDark={color?.dark} />
  )
}
