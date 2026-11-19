import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for plan 042: the SPA must not fetch fonts (or anything
 * else) from third-party origins. Fonts are self-hosted through @fontsource
 * and served from `self`; the nginx CSP is tightened to match.
 */
describe('no third-party asset origins', () => {
  for (const file of ['index.html', 'nginx.conf']) {
    it(`${file} does not reference Google Fonts`, () => {
      const src = readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), 'utf8');
      expect(src).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    });
  }
});
