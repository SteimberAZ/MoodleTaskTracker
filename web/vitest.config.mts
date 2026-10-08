import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
  // Same JSX runtime as Next, so component files render under test without importing React.
  esbuild: { jsx: 'automatic' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
