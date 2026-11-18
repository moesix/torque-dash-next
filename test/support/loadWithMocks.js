'use strict';

// Centralized module-mocking seam for the unit suites.
//
// Production modules use normal top-level requires, so a test that needs a
// different dependency graph must load the target with its ENTIRE dependency
// chain purged and replaced. This helper makes that purge list explicit:
//
//   loadWithMocks(target, mocks, purgePaths)
//     - installs each `{ path, exports }` mock in require.cache,
//     - deletes the target and every `purgePaths` entry,
//     - requires the target (which re-reads the mocks),
//     - returns { module, restore() } to put the original cache entries back.
//
// Paths are resolved from the test/ directory (e.g. '../models'), so callers
// keep writing the same specifiers they use in normal requires.

const path = require('path');

const TEST_DIR = path.resolve(__dirname, '..');

function resolveTestPath(modulePath) {
    return require.resolve(path.resolve(TEST_DIR, modulePath));
}

function loadWithMocks(targetModule, mocks = [], purgePaths = []) {
    const saved = new Map();

    const remember = (resolved) => {
        if (!saved.has(resolved)) saved.set(resolved, require.cache[resolved]);
    };

    for (const m of mocks) {
        const resolved = resolveTestPath(m.path);
        remember(resolved);
        require.cache[resolved] = {
            id: resolved,
            filename: resolved,
            loaded: true,
            exports: m.exports,
        };
    }

    // Delete the whole chain BEFORE requiring the target: if a purge path were
    // removed after the target loaded, `remember` would capture the newly
    // loaded (mock-bound) module as the "previous" entry and restore() would
    // leave it behind for the next test.
    let targetResolved;
    for (const modulePath of [targetModule, ...purgePaths]) {
        if (!modulePath) continue;
        const resolved = resolveTestPath(modulePath);
        remember(resolved);
        delete require.cache[resolved];
        if (modulePath === targetModule) targetResolved = resolved;
    }

    const loaded = targetResolved ? require(targetResolved) : undefined;

    function restore() {
        for (const [resolved, previous] of saved) {
            if (previous) require.cache[resolved] = previous;
            else delete require.cache[resolved];
        }
    }

    return { module: loaded, restore };
}

module.exports = { loadWithMocks };
