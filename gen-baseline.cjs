const fs = require('fs');
const files = fs.readFileSync('undeclared-files.txt', 'utf8').trim().split('\n');

let content = `/**
 * Baseline of files that are currently not declared in the architecture manifest.
 * This list exists for the transition from concern-header-based checking to location-based checking.
 * Files not in the manifest and not in this baseline will fail the architecture check.
 *
 * As modules are added to the manifest, remove files from this baseline.
 * A new undeclared file will fail the check until added here.
 * A stale baseline entry (file now in manifest) will fail until removed.
 *
 * This baseline only shrinks; it never grows as part of this check.
 */

export const undeclaredModulesBaseline: readonly string[] = [
`;

for (let i = 0; i < files.length; i++) {
  content += `  "${files[i]}"${i < files.length - 1 ? ',' : ''}\n`;
}

content += "];\n";

fs.writeFileSync('scripts/quality/undeclared-modules-baseline.ts', content);
console.log(`Wrote ${files.length} files to baseline`);
