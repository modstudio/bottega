/** Return module specifiers from static imports, dynamic imports, and require calls. */
export function importSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g
  return [...source.matchAll(pattern)].map((match) => match[1]!)
}
