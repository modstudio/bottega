/**
 * A tag label in Title Case: `in_progress` and `In progress` both read
 * "In Progress". Existing capitals stay, so acronyms such as OK survive.
 */
export function titleCase(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
}
