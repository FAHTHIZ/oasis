import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('the canonical project license and package/README declarations agree on Apache-2.0', async () => {
  const [license, pkgText, readme, projectPlan] = await Promise.all([
    read('LICENSE'), read('package.json'), read('README.md'), read('docs/PROJECT_PLAN.md')
  ]);
  const pkg = JSON.parse(pkgText);
  assert.match(license, /Apache License[\s\S]*Version 2\.0, January 2004/);
  for (const section of ['1. Definitions.', '2. Grant of Copyright License.', '3. Grant of Patent License.', '4. Redistribution.', '5. Submission of Contributions.', '6. Trademarks.', '7. Disclaimer of Warranty.', '8. Limitation of Liability.', '9. Accepting Warranty or Additional Liability.', 'APPENDIX: How to apply the Apache License']) {
    assert.ok(license.includes(section), 'LICENSE must include ' + section);
  }
  assert.equal(pkg.license, 'Apache-2.0');
  assert.match(readme, /license-Apache--2\.0/);
  assert.match(readme, /Apache License 2\.0 — see \[LICENSE\]\(LICENSE\)/);
  assert.match(projectPlan, /\*\*Product lifecycle:\*\* Stable/);
  assert.ok(projectPlan.includes('**Package version:** `' + pkg.version + '`'), 'PROJECT_PLAN states the package version');
  assert.match(pkg.version, /^1\.\d+\.\d+$/);
  assert.equal(pkg.oasisRelease?.channel, 'stable');
  assert.equal(pkg.oasisRelease?.stableTag, 'v' + pkg.version);
});

test('published documentation describes the project as Apache-2.0, not MIT', async () => {
  const [launch, brand, guide] = await Promise.all([
    read('docs/REPOSITORY_MAINTENANCE.md'), read('docs/BRAND.md'), read('docs/USER_GUIDE.md')
  ]);
  assert.match(launch, /License: Apache-2\.0/);
  assert.doesNotMatch(launch, /MIT license/i);
  assert.match(brand, /Code\. Automate\. Flourish\./);
  assert.match(guide, /## License\s+\s+Apache License 2\.0\. See \[LICENSE\]\(\.\.\/LICENSE\)\./);
});
