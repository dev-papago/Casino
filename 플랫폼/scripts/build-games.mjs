// Builds the games and puts them where the ledger server serves them: dist/games/<id>/index.html.
// Each game is its own project next to this one (its single-file build is all it needs); run after `vite build`.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const GAMES = { yabawi: '야바위', yeongkkeul: '영끌문S' };

for (const [id, folder] of Object.entries(GAMES)) {
  const dir = resolve(root, '..', folder);
  if (!existsSync(join(dir, 'node_modules'))) execSync('npm install --ignore-scripts', { cwd: dir, stdio: 'inherit' });
  execSync('npm run build', { cwd: dir, stdio: 'inherit' });
  mkdirSync(join(root, 'dist', 'games', id), { recursive: true });
  copyFileSync(join(dir, 'dist', 'index.html'), join(root, 'dist', 'games', id, 'index.html'));
  console.log(`games/${id}/index.html ← ${folder}/dist/index.html`);
}
