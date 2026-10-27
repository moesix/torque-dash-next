'use strict';

// ── CSV export helpers (plans/017) ─────────────────────────────────────────
// Extracted from controllers/SessionController.js with the code moved verbatim.
// Pure functions — no model imports, so they are safe to require in tests
// without DATABASE_URL and reusable by any future exporter.

/**
 * Format a [start, end] pair into a compact human-readable duration string.
 * Returns null when either bound is missing.
 * Produces e.g. "1h 2m 5s" or "3d 1h 0m 5s", trimming leading zero units.
 */
function formatDuration(start, end) {
    if (!start || !end) return null;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 0) return null;
    const totalSeconds = Math.floor(ms / 1000);
    const d = Math.floor(totalSeconds / 86400);
    const h = Math.floor((totalSeconds % 86400) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

/**
 * Strip path-dangerous chars from session names for Content-Disposition
 * filenames, replace spaces with hyphens, and cap at 100 characters.
 */
function sanitizeFilename(name) {
    return (String(name)
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 100)
    ) || 'session';
}

/**
 * Escape a single CSV cell value: null/undefined -> empty string; if the value
 * contains commas, double-quotes, newlines, carriage returns, or tabs, wrap it
 * in double-quotes and escape embedded quotes as "".  Also prefix cells starting
 * with +, -, =, @, or | with a single quote to prevent Excel formula injection.
 */
function csvEscape(val) {
    if (val === null || val === undefined) return '';
    let str = String(val);
    // Excel formula injection guard: prefix dangerous leading chars
    if (/^[+\-=@|]/.test(str)) {
        str = "'" + str;
    }
    if (/[,"\n\r\t]/.test(str)) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

module.exports = { formatDuration, sanitizeFilename, csvEscape };
