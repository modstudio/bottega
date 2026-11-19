/** Whether a checkout is exactly a registered project path or is contained beneath it. */
export function checkoutIsUnderProject(checkout: string, projectPath: string): boolean {
  return checkout === projectPath || checkout.startsWith(`${projectPath}/`)
}
