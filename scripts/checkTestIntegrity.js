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
//
// Also fails when anything else ending in .js lives directly under test/:
// `node --test test/` resolves the directory as "every .js file" on Node
// 20.19 but "*.test.js only" on Node 22+, so a stray helper would run as a
// test on one runtime and silently not on another.

const path = require('path');
const fs = require('fs');

const MARKERS = ['reproduce', 'replicate', 'mirror of', 'local fallback'];
const JUSTIFICATION = 'NOTE: intentionally standalone';
const TEST_DIR = path.join(__dirname, '..', 'test');

let exitCode = 0;
let markerOffenders = 0;
let strayCount = 0;

const entries = fs.readdirSync(TEST_DIR, { withFileTypes: true });

// Naming guard: only *.test.js may sit at the top level of test/.
const strayFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.test.js'))
    .map((e) => e.name)
    .sort();

for (const file of strayFiles) {
    console.error(
        `[checkTestIntegrity] test/${file}: only *.test.js files may live under test/ — ` +
        `Node 20.19 directory-mode runs every .js file here, Node 22+ runs only *.test.js, ` +
        `so "${file}" would be a test on one runtime and a silent no-op on the other; ` +
        `rename it to "${path.parse(file).name}.test.js" or move it out of test/`
    );
    strayCount += 1;
    exitCode = 1;
}

const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.test.js'))
    .map((e) => e.name)
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
        markerOffenders += 1;
        exitCode = 1;
    }
}

if (exitCode === 0) {
    console.log('[checkTestIntegrity] No unjustified mirror markers in test/');
    console.log('[checkTestIntegrity] All files under test/ are named *.test.js');
} else {
    if (markerOffenders > 0) {
        console.error(`[checkTestIntegrity] ${markerOffenders} unjustified mirror marker(s) found`);
    }
    if (strayCount > 0) {
        console.error(`[checkTestIntegrity] ${strayCount} file(s) under test/ are not named *.test.js`);
    }
}
process.exit(exitCode);
