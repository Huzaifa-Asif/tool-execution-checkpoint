import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src', 'test', 'scripts', 'examples'];
const files = [];
for (const root of roots) {
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:c?js|mjs)$/.test(path)) files.push(path);
    }
  };
  walk(root);
}
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  const text = readFileSync(file, 'utf8');
  if (/[ \t]+$/m.test(text)) throw new Error(`${file}: trailing whitespace`);
  if (!text.endsWith('\n')) throw new Error(`${file}: missing final newline`);
}
console.log(`lint checked ${files.length} JavaScript files`);
