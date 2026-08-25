#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

// Extract object literal keys and fields from a JS file
function extractMap(filePath, varName) {
    const src = fs.readFileSync(filePath, 'utf8');
    // Simple regex extraction — works for flat object literals
    const match = new RegExp(`${varName}\\s*[^=]*?=\\s*\\{([\\s\\S]*?)\\};`, 'm').exec(src);
    if (!match) return null;
    const entries = {};
    const entryRe = /(\w+)\s*:\s*\{([^}]+)\}/g;
    let m;
    while ((m = entryRe.exec(match[1]))) {
        const key = m[1];
        const fields = {};
        const fieldRe = /(\w+)\s*:\s*'([^']*)'/g;
        let f;
        while ((f = fieldRe.exec(m[2]))) {
            fields[f[1]] = f[2];
        }
        entries[key] = fields;
    }
    return entries;
}

let exitCode = 0;

// Check PID registry parity
const backendPids = extractMap(
    path.join(__dirname, '..', 'lib', 'pidRegistry.js'), 'PID_REGISTRY'
);
const frontendPids = extractMap(
    path.join(__dirname, '..', 'apps', 'frontend', 'src', 'lib', 'pidDecode.ts'), 'FALLBACK_MAP'
);

if (backendPids && frontendPids) {
    // Field name mapping: backend uses fullName/shortName, frontend uses full/short
    const fieldMap = { fullName: 'full', shortName: 'short' };
    for (const [key, fields] of Object.entries(backendPids)) {
        const ff = frontendPids[key];
        if (!ff) {
            console.error(`[checkMirrors] PID ${key} in backend but not frontend`);
            exitCode = 1;
            continue;
        }
        for (const [field, value] of Object.entries(fields)) {
            const frontendField = fieldMap[field] || field;
            if (ff[frontendField] !== value) {
                console.error(`[checkMirrors] PID ${key}.${field}: backend="${value}" frontend="${ff[frontendField]}"`);
                exitCode = 1;
            }
        }
    }
    for (const key of Object.keys(frontendPids)) {
        if (!backendPids[key]) {
            console.error(`[checkMirrors] PID ${key} in frontend but not backend`);
            exitCode = 1;
        }
    }
} else {
    console.error('[checkMirrors] Could not extract maps');
    exitCode = 1;
}

// Check LLM providers parity
const backendProviders = extractMap(
    path.join(__dirname, '..', 'lib', 'llmProviders.js'), 'PROVIDERS'
);
// Frontend providers are in AiProviderCard.tsx as an array — extract differently
const aiCardSrc = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'frontend', 'src', 'features', 'settings', 'AiProviderCard.tsx'), 'utf8'
);
const providerMatch = /const PROVIDERS\s*=\s*\[([\s\S]*?)\];/.exec(aiCardSrc);
if (providerMatch && backendProviders) {
    const frontendProviders = {};
    const provRe = /value:\s*'(\w+)'.*?models:\s*\[([^\]]*)\]/g;
    let p;
    while ((p = provRe.exec(providerMatch[1]))) {
        frontendProviders[p[1]] = p[2];
    }
    for (const key of Object.keys(backendProviders)) {
        if (!Object.prototype.hasOwnProperty.call(frontendProviders, key)) {
            console.error(`[checkMirrors] Provider ${key} in backend but not frontend`);
            exitCode = 1;
        }
    }
}

if (exitCode === 0) {
    console.log('[checkMirrors] All mirrors in sync');
}
process.exit(exitCode);
