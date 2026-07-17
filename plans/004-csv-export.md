# Plan 004 — CSV Export per Session

## Goal

Add a "Download CSV" button that exports all telemetry data for a session as a CSV file. The export must handle sessions of any size (no row limit), dynamically discover PID columns, and stream the response to avoid memory issues.

## Scope

| In scope | Out of scope |
|----------|-------------|
| Backend streaming CSV endpoint | Batch/multi-session export |
| Frontend download button on ReplayDashboard | Export from session list (future) |
| Ownership enforcement (authenticated users only) | Shared session export |
| Dynamic PID column discovery from JSONB | Column reordering or custom export formats |

---

## 1. Backend — New Endpoint

**Route:** `GET /api/sessions/:sessionId/export/csv`

**File:** `controllers/SessionController.js` — add `static async exportCsv(req, res)`

### 1.1 Ownership check

```javascript
const session = await Session.findOne({
  where: { id: req.params.sessionId, userId: req.user.id }
});
if (!session) return res.status(404).json({ error: 'Session not found' });
```

### 1.2 Discover all PID keys (two-pass approach)

The `values` JSONB column contains Torque hex keys (`k*`) plus metadata keys (`userFullName*`, `userUnit*`, etc.). We need to:

1. **First pass** — Scan all rows to collect the union of all `k*` keys across the session.
2. **Build CSV header** — Fixed columns (`timestamp`, `lat`, `lon`) + discovered PID keys sorted alphabetically.
3. **Second pass** — Stream rows, extracting values from `values->>'key'` for each discovered key.

**Implementation:** Use a single query with `jsonb_object_keys` to discover keys, then stream with `Log.findAll({ raw: true })`.

```sql
-- Discover all distinct k* keys in one query
SELECT DISTINCT key FROM (
  SELECT jsonb_object_keys(values) AS key FROM "Logs" WHERE "sessionId" = :sessionId
) sub WHERE key ~ '^k' AND length(key) > 1
ORDER BY key;
```

**Alternative (simpler, JS-side):** Since we're already streaming all rows, scan `values` keys in JS during the first few rows and build headers dynamically. This avoids a separate SQL query but means the header row might be incomplete if the first batch doesn't contain all keys. **Recommendation:** Use the SQL approach for correctness.

### 1.3 Stream CSV response

```javascript
static async exportCsv(req, res) {
  try {
    // 1. Ownership check
    const session = await Session.findOne({
      where: { id: req.params.sessionId, userId: req.user.id }
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // 2. Discover all k* keys via SQL
    const [keyRows] = await sequelize.query(`
      SELECT DISTINCT key FROM (
        SELECT jsonb_object_keys(values) AS key
        FROM "Logs" WHERE "sessionId" = :sessionId
      ) sub
      WHERE key ~ '^k' AND length(key) > 1
      ORDER BY key
    `, { replacements: { sessionId: session.id } });

    const pidKeys = keyRows.map(r => r.key);

    // 3. Set headers for streaming CSV download
    const filename = sanitizeFilename(session.name || `session-${session.id}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);

    // 4. Write header row
    const fixedCols = ['timestamp', 'lat', 'lon'];
    const header = [...fixedCols, ...pidKeys];
    res.write(header.join(',') + '\n');

    // 5. Stream data rows using cursor-based pagination
    //    (avoids O(n) degradation on large sessions that offset causes)
    const BATCH_SIZE = 1000;
    let lastTimestamp = null;
    let hasMore = true;

    while (hasMore) {
      const where = { sessionId: session.id };
      if (lastTimestamp) {
        where.timestamp = { [Op.gt]: lastTimestamp };
      }

      const batch = await Log.findAll({
        where,
        attributes: ['timestamp', 'lat', 'lon', 'values'],
        order: [['timestamp', 'ASC']],
        limit: BATCH_SIZE,
        raw: true
      });

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      for (const row of batch) {
        const values = row.values || {};
        const cells = [
          csvEscape(new Date(row.timestamp).toISOString()),
          csvEscape(row.lat),
          csvEscape(row.lon),
          ...pidKeys.map(k => csvEscape(values[k]))
        ];
        res.write(cells.join(',') + '\n');
      }

      lastTimestamp = batch[batch.length - 1].timestamp;
      if (batch.length < BATCH_SIZE) hasMore = false;
    }

    res.end();
  } catch (err) {
    console.error('[SessionController.exportCsv]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Export failed' });
    } else {
      res.end();
    }
  }
}
```

### 1.4 Helper functions

```javascript
// Sanitize session name for Content-Disposition filename
function sanitizeFilename(name) {
  return name
    .replace(/[^a-zA-Z0-9_\- ]/g, '')  // strip special chars
    .replace(/\s+/g, '-')               // spaces to hyphens
    .slice(0, 100)                       // cap length
    || 'session';                        // fallback
}

// Escape a value for CSV (handle commas, quotes, newlines, tabs)
function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[,"\n\r\t]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
```

### 1.5 Route registration

**File:** `routes/api.js`

```javascript
router.get('/sessions/:sessionId/export/csv', authenticate, SessionController.exportCsv);
```

Place this **after** the catch-all limiter (`router.use(makeLimiter(rateLimits.global))` at line 60), alongside the other session routes (e.g., after line 74). This ensures the export endpoint is rate-limited like all other `/api` routes — it's an expensive full-table-scan operation.

**Note:** Express matches routes in registration order. The export route (`/sessions/:sessionId/export/csv`, 3 path segments) cannot match the existing `GET /sessions/:sessionId` pattern (1 segment after prefix), so there is no route conflict regardless of placement. Rate limiting is the only reason to place it after the global limiter.

---

## 2. Frontend — Download Button

### 2.1 API function

**File:** `apps/frontend/src/lib/api.ts`

```typescript
export async function exportSessionCsv(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/export/csv`, {
    credentials: 'include',
  });

  if (res.status === 401) {
    window.location.assign('/login');
    throw new ApiError('Unauthorized', 401);
  }
  if (!res.ok) {
    throw new ApiError(`Export failed: ${res.status}`, res.status);
  }

  // Extract filename from Content-Disposition header
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = disposition.match(/filename="?([^";\n]+)"?/);
  const filename = match?.[1] ?? `session-${sessionId}.csv`;

  // Create blob and trigger download
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
```

### 2.2 UI Button

**File:** `apps/frontend/src/features/dashboard/ReplayDashboard.tsx`

Add a download button near the existing fullscreen toggle button in the dashboard header area. Use a simple download icon (inline SVG or a text label "CSV").

```tsx
import { exportSessionCsv } from '../../lib/api';

// In the dashboard header, next to the fullscreen button:
<button
  onClick={() => id && exportSessionCsv(id)}
  className="... download button styling ..."
  title="Download session as CSV"
>
  {/* Download icon or "CSV" text */}
</button>
```

### 2.3 Loading state

The download may take a few seconds for large sessions. Add `isExporting` state to disable the button while the fetch is in progress:

```tsx
const [isExporting, setIsExporting] = useState(false);

// In the button:
<button
  onClick={async () => {
    if (!id) return;
    setIsExporting(true);
    try {
      await exportSessionCsv(id);
    } finally {
      setIsExporting(false);
    }
  }}
  disabled={isExporting}
  title="Download session as CSV"
>
  {isExporting ? '...' : 'CSV'}
</button>
```

---

## 3. Files to Modify

| File | Change |
|------|--------|
| `controllers/SessionController.js` | Add `exportCsv` static method + `sanitizeFilename` + `csvEscape` helpers |
| `routes/api.js` | Register `GET /sessions/:sessionId/export/csv` route |
| `apps/frontend/src/lib/api.ts` | Add `exportSessionCsv()` function |
| `apps/frontend/src/features/dashboard/ReplayDashboard.tsx` | Add download button |
| `plans/004-csv-export.md` | This plan |

---

## 4. Edge Cases & Gotchas

| Issue | Handling |
|-------|----------|
| **Empty session** | Return CSV with only header row (no data rows) |
| **Session with no `values`** | Return header + rows with empty PID columns |
| **Very large session (30K+ rows)** | Batched queries (1000 rows/batch) keep memory constant; streaming `res.write()` avoids buffering |
| **Compressed hypertable chunks** | TimescaleDB compression is transparent — Sequelize queries work normally |
| **CSV injection** | PID values are numeric (from `coerceScalar`). Session names are not in the export. Risk is negligible, but `csvEscape` handles any edge case. |
| **Special chars in session name** | `sanitizeFilename` strips non-alphanumeric chars, replaces spaces with hyphens, caps at 100 chars |
| **Auth cookie not sent** | `credentials: 'include'` on the fetch ensures the session cookie travels |
| **Concurrent session edits** | Export reads a point-in-time snapshot; concurrent cuts/copies may cause minor inconsistencies. Acceptable for export use case. |

---

## 5. Testing Strategy

### Manual verification
1. Create a session with Torque Pro, wait for upload
2. Click download button → verify CSV opens correctly in Excel/Google Sheets
3. Verify header row contains `timestamp,lat,lon` + all PID keys
4. Verify data rows align with chart data
5. Test with a large session (10K+ rows) — verify streaming works without timeout
6. Test with an empty session — verify header-only CSV

### Edge case tests
- Unauthenticated request → 401
- Another user's session → 404
- Non-existent session → 404
- Session name with special characters → sanitized filename

---

## 6. Complexity Estimate

| Component | Effort |
|-----------|--------|
| Backend endpoint + helpers | ~80 lines |
| Route registration | ~1 line |
| Frontend API function | ~25 lines |
| Frontend button | ~15 lines |
| **Total** | **~1.5 days** |

---

## 7. Future Enhancements (out of scope)

- Export from session list (batch download)
- Export shared sessions (public link)
- Custom column selection (user picks which PIDs to include)
- JSON export format
- Progress indicator for very large exports
