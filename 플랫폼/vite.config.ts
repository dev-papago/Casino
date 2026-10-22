/// <reference types="vitest/config" />
// Pages served by the ledger server: index.html (player), admin.html (admin PC only), the arcade games
// (games/plinko, games/slot, games/yacht → dist/games/<id>/index.html) and the 데스 게임 (games/deathgame, styled
// with Tailwind: only its stylesheet has @tailwind in it). 야바위 and 영끌문S are their own projects
// (scripts/build-games.mjs).
import { resolve } from 'node:path';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';

const ARCADE = ['plinko', 'slot', 'yacht', 'deathgame'];

export default defineConfig({
  base: './',
  css: {
    postcss: {
      plugins: [tailwindcss({ content: [resolve(import.meta.dirname, 'games/deathgame/**/*.{html,js}')] })],
    },
  },
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
        rank: resolve(import.meta.dirname, 'rank.html'),
        sim: resolve(import.meta.dirname, 'sim.html'),
        ...Object.fromEntries(ARCADE.map((id) => [id, resolve(import.meta.dirname, 'games', id, 'index.html')])),
      },
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
