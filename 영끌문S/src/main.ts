// Boot: mount the UI.
import './ui/style.css';
import { mountApp } from './ui/app.ts';

const root = document.getElementById('app');
if (root) mountApp(root);
