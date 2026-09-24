export function operatorKnowledgeSection(pack: { markdown: string } | null): string {
  return pack?.markdown ? `WHAT THE OPERATOR WANTS YOU TO KNOW\n\n${pack.markdown}` : ''
}
