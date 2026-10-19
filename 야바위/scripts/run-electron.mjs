// Launches Electron on the built app. VS Code's integrated terminal exports ELECTRON_RUN_AS_NODE=1,
// which makes Electron behave like plain Node (require('electron').app is undefined), so drop it here.
import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
