/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: { target: 'es2022', modulePreload: { polyfill: false } },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
