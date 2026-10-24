import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const allowed = new Set(['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04', 'macos-latest', 'macos-15', 'macos-14']);
const directory = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
  const source = readFileSync(`${directory}/${file}`, 'utf8');
  assert(/^permissions:\s*\n/m.test(source), `${file}: explicit workflow permissions required`);
  assert(!/\bself-hosted\b/i.test(source), `${file}: only GitHub-hosted labels are permitted`);
  for (const action of source.matchAll(/^\s+- uses:\s+(.*)$/gm)) {
    assert(/^[\w.-]+\/[\w./-]+@[a-f\d]{40}\s+# v\d/.test(action[1]), `${file}: full SHA and version comment required`);
  }
  const jobs = source.split(/^jobs:\s*\n/m)[1];
  assert(jobs, `${file}: jobs required`);
  for (const match of jobs.matchAll(/^ {2}([\w-]+):\s*\n([\s\S]*?)(?=^ {2}[\w-]+:\s*\n|$(?![\s\S]))/gm)) {
    const job = match[2];
    assert(/^ {4}timeout-minutes:\s*[1-9]\d*\s*$/m.test(job), `${file}/${match[1]}: positive timeout required`);
    const reusable = /^ {4}uses:\s*(.*)$/m.exec(job);
    if (reusable) {
      assert(reusable[1].startsWith('./.github/workflows/'), `${file}: reusable workflows must be local`);
      continue;
    }
    const label = /^ {4}runs-on:\s*(.*)$/m.exec(job)?.[1]?.trim();
    assert(label, `${file}/${match[1]}: runs-on required`);
    const matrix = /^\$\{\{\s*matrix\.(\w+)\s*\}\}$/.exec(label);
    if (matrix) {
      const axis = new RegExp(`^        ${matrix[1]}: \\[([^\\]]+)\\]`, 'm').exec(job);
      assert(axis, `${file}: runner matrix must be a static axis`);
      assert(!/^ {8}include:/m.test(job), `${file}: mixed axis/include matrices are forbidden`);
      for (const value of axis[1].split(','))
        assert(allowed.has(value.trim().replace(/^['"]|['"]$/g, '')), `${file}: invalid matrix runner`);
    } else assert(allowed.has(label), `${file}: invalid literal runner ${label}`);
    assert(
      !/\b(?:actions\/cache|upload-artifact|download-artifact)@/.test(job),
      `${file}: caches/artifacts require a measured need`,
    );
  }
}
console.log('Workflow policy verified: hosted labels, static matrices, action SHAs, permissions and timeouts.');
