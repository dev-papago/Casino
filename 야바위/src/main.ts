// Boot: load settings + state, mount the UI.
import './ui/style.css';
import { loadSettings } from './config';
import { loadState } from './storage';
import { mountApp, parseSpeed } from './ui/app';

const root = document.getElementById('app');
if (root) mountApp(root, { settings: loadSettings(), state: loadState(), speed: parseSpeed(location.search) });
