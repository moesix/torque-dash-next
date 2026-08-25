#!/usr/bin/env node
'use strict';

// Structural tripwire against test-suite mirrors (plan 081).
//
// Fails when any test/*.test.js file contains a mirror-marker phrase
// WITHOUT a same-file justification marker ("NOTE: intentionally
// standalone"). Matching is case-insensitive substring on the SINGULAR
// verb stems ("reproduce", "replicate") so every inflection — reproduces,
// replicates, replicating, Replicated, ... — is caught too. Kept dumb and
// visible on purpose: extend MARKERS as new phrasings appear.

const path = require('path');
const fs = require('fs');

const MARKERS = ['reproduce', 'replicate', 'mirror of', 'local fallback'];
const JUSTIFICATION = 'NOTE: intentionally standalone';
const TEST_DIR = path.join(__dirname, '..', 'test');

let exitCode = 0;
let offenderCount = 0;

const files = fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

for (const file of files) {
    const filePath = path.join(TEST_DIR, file);
    const src = fs.readFileSync(filePath, 'utf8');
    const lower = src.toLowerCase();

    const hits = [];
    for (const marker of MARKERS) {
        let idx = lower.indexOf(marker);
        while (idx !== -1) {
            const line = src.slice(0, idx).split('\n').length;
            hits.push({ line, marker });
            idx = lower.indexOf(marker, idx + marker.length);
        }
    }

    if (hits.length === 0) continue;

    // Same-file justification marker accepts every marker in this file.
    if (src.includes(JUSTIFICATION)) continue;

    for (const hit of hits) {
        console.error(
            `[checkTestIntegrity] test/${file}:${hit.line}: ` +
            `marker "${hit.marker}" without justification ("${JUSTIFICATION}")`
        );
        offenderCount += 1;
        exitCode = 1;
    }
}

if (exitCode === 0) {
    console.log('[checkTestIntegrity] No unjustified mirror markers in test/');
} else {
    console.error(`[checkTestIntegrity] ${offenderCount} unjustified mirror marker(s) found`);
}
process.exit(exitCode);
