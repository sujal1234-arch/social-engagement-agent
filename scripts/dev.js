// Starts backend (:4000) and frontend (:5173) together, cross-platform.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const procs = [
  spawn('npm', ['start'], { cwd: path.join(root, 'backend'), shell: true, stdio: 'inherit' }),
  spawn('npm', ['run', 'dev'], { cwd: path.join(root, 'frontend'), shell: true, stdio: 'inherit' }),
];

function shutdown() {
  for (const p of procs) p.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
