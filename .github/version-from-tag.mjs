// Writes a tag's version (`v1.2.3` → 1.2.3, the argument) into the files that hold one, for the
// build in CI only (build.yml); nothing is committed. Node instead of sed: the same on every runner.
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+/.test(version ?? '')) throw new Error(`not a version: ${version}`);

const edit = (file, pattern) => {
  const text = readFileSync(file, 'utf8');
  if (!pattern.test(text)) throw new Error(`no version in ${file}`);
  writeFileSync(file, text.replace(pattern, (_, before) => `${before}${version}"`));
};

// The first match in each: the package's own version, not a dependency's.
edit('desktop/Cargo.toml', /^(version = ")[^"]*"/m);
edit('desktop/tauri.conf.json', /("version": ")[^"]*"/);
edit('package.json', /("version": ")[^"]*"/);
