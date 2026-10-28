// concern: metered route policy
/** Pure metered-provider admission; repository policy supplies writesRepo. */

export function meteredRouteEligibility(input: {
  billing: string
  routeMetered: boolean
  trainsOnInputs?: boolean
  writesRepo: boolean
  name: string
  explicitlyNamedAgent?: string
}): { eligible: boolean; why: string; mayAutoRouteNamedJob: boolean } {
  if (
    (input.billing !== 'metered' && !input.trainsOnInputs) ||
    input.explicitlyNamedAgent === input.name
  )
    return {
      eligible: true,
      why: '',
      mayAutoRouteNamedJob: input.explicitlyNamedAgent === input.name,
    }
  if (!input.routeMetered)
    return {
      eligible: false,
      why: input.trainsOnInputs
        ? 'a provider that may train on inputs is not opted in for automatic routing'
        : 'metered billing is not opted in for automatic routing',
      mayAutoRouteNamedJob: false,
    }
  if (input.writesRepo)
    return {
      eligible: false,
      why: 'metered routing opt-in is limited to jobs that do not write the repository',
      mayAutoRouteNamedJob: false,
    }
  return { eligible: true, why: '', mayAutoRouteNamedJob: true }
}
