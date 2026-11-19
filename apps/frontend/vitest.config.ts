import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text-summary', 'json-summary'],
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['src/**/__tests__/**', 'src/**/*.test.*', 'src/main.tsx', 'src/vite-env.d.ts'],
            // Ratchet floors, measured 2026-11-19 with this include set
            // (the pre-039 baseline): 54.47% lines / 46.80% functions
            // (statements 54.17 / branches 43.12). Each floor is the measured
            // value minus 2. Raise by ~2 points per release once stable.
            thresholds: { lines: 52, functions: 44 },
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src'),
        },
    },
});
