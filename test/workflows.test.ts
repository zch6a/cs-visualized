// The CI and Pages workflows: every action pinned to a commit, no token left in the checkout, read-only by default,
// and the rights that publish the site only in the job that runs nothing of the project.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

test('workflows are pinned and read-only by default', () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.yml'))) {
    const yml = readFileSync(join(DIR, file), 'utf8').replace(/\r\n/g, '\n');
    const uses = [...yml.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? '');
    assert.ok(uses.length > 0, file);
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${file}: ${u}`);
    for (const block of yml.split(/uses: actions\/checkout@/).slice(1)) assert.match(block, /^\S+[^\n]*\n\s+with:\n\s+persist-credentials: false/, `${file}: checkout keeps the token`);
    assert.match(yml, /^permissions:\n\s+contents: read$/m, `${file}: read-only by default`);
    for (const run of yml.split('\n').filter((l) => /^\s*-?\s*run:/.test(l))) assert.ok(!/npm ci(?! --ignore-scripts)/.test(run), `${file}: ${run.trim()}`);
  }
});

test('the job that can publish the site runs no project code', () => {
  const yml = readFileSync(join(DIR, 'pages.yml'), 'utf8').replace(/\r\n/g, '\n');
  const deploy = yml.slice(yml.indexOf('\n  deploy:'));
  assert.match(deploy, /pages: write/);
  assert.doesNotMatch(deploy, /\brun:/, 'no run steps next to the publishing rights');
  const build = yml.slice(yml.indexOf('\n  build:'), yml.indexOf('\n  deploy:'));
  assert.doesNotMatch(build, /pages: write|id-token: write/);
});
