const { Op } = require('sequelize');
const Session = require('../models').Session;
const Log = require('../models').Log;
const Analysis = require('../models').Analysis;
const Vehicle = require('../models').Vehicle;
const Settings = require('../models').Settings;
const sequelize = require('../models').sequelize;
const { analyze, streamEvents } = require('../lib/llmProviders');
const { buildAnalysisPrompt, formatSessionDuration, buildDataQualityNote, GAP_ANALYSIS } = require('../lib/llmPrompt');
const { discoverPidKeys } = require('../lib/pidRegistry');
const { classifyAnalysisError } = require('../lib/analysisErrors');
const { isInt4Id } = require('../lib/validators');
const { requireAdmin } = require('./UserController');

// Sessions with an analysis stream currently running. Single-container compose
// assumption (same as ingestBuffer): one process owns the set, so a duplicate
// request is rejected instead of paying the provider twice.
const inFlight = new Set();

class AnalysisController {
  // Gap/peak stats in one round trip (plans/014). Reference semantics:
  // detectBackfillGaps() in lib/llmPrompt.js. That function reports every
  // interval >= GAP_ANALYSIS.MIN_GAP_SECONDS as {startIso, endIso, seconds}
  // (seconds rounded), sorted longest-first and capped at MAX_REPORTED_GAPS,
  // plus maxRowsInMinute from per-minute row counts (0 for an empty session).
  //
  // Both branches read the session's timestamps through one MATERIALIZED
  // `base` CTE, so the table is scanned once and only the capped gap rows
  // (LIMIT :maxGaps) travel back to Node.
  static async computeGapSummary(sessionId) {
    const rows = await sequelize.query(`
      WITH base AS MATERIALIZED (
        SELECT "timestamp" FROM "Logs" WHERE "sessionId" = :sessionId
      ), ordered AS (
        SELECT "timestamp" AS curr_ts,
               LAG("timestamp") OVER (ORDER BY "timestamp") AS prev_ts
        FROM base
      ), gap_rows AS (
        SELECT prev_ts AS gap_start, curr_ts AS gap_end,
               EXTRACT(EPOCH FROM curr_ts - prev_ts)::float AS seconds
        FROM ordered
        WHERE prev_ts IS NOT NULL
          AND EXTRACT(EPOCH FROM curr_ts - prev_ts) >= :minGapSeconds
      ), reported_gaps AS (
        -- Longest-first with the ROUNDED seconds, ties broken chronologically,
        -- mirroring the pure fn's stable desc sort before its cap.
        SELECT gap_start, gap_end, seconds
        FROM gap_rows
        ORDER BY ROUND(seconds::numeric) DESC, gap_start ASC
        LIMIT :maxGaps
      ), minute_counts AS (
        SELECT date_trunc('minute', "timestamp") AS bucket, COUNT(*) AS cnt
        FROM base
        GROUP BY 1
      )
      SELECT 'gap' AS kind, gap_start, gap_end, seconds, NULL::bigint AS cnt FROM reported_gaps
      UNION ALL
      SELECT 'peak', NULL::timestamptz, NULL::timestamptz, NULL::float, MAX(cnt) FROM minute_counts
      ORDER BY gap_start NULLS LAST
    `, {
      replacements: {
        sessionId,
        minGapSeconds: GAP_ANALYSIS.MIN_GAP_SECONDS,
        maxGaps: GAP_ANALYSIS.MAX_REPORTED_GAPS,
      },
      type: sequelize.QueryTypes.SELECT,
    });

    // SQL already ordered by rounded seconds (ties chronological) and capped
    // the transfer; this desc sort + slice is idempotent and keeps the JS
    // output identical to the pure function's.
    const gaps = rows
      .filter(r => r.kind === 'gap')
      .map(r => ({
        startIso: new Date(r.gap_start).toISOString(),
        endIso: new Date(r.gap_end).toISOString(),
        seconds: Math.round(Number(r.seconds)),
      }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, GAP_ANALYSIS.MAX_REPORTED_GAPS);

    const peak = rows.find(r => r.kind === 'peak');
    return { gaps, maxRowsInMinute: peak && peak.cnt != null ? Number(peak.cnt) : 0 };
  }

  // Evenly spaced middle ids for large sessions (plans/014). Same selection
  // as the pre-SQL JS loop: target = min(100, total), stride = max(1,
  // floor(total / target)), every stride-th id in id order until target is
  // reached. LIMIT bounds the transfer instead of shipping every id.
  static async selectEvenIds(sessionId, totalCount) {
    const target = Math.min(100, totalCount);
    if (target <= 0) return [];
    const stride = Math.max(1, Math.floor(totalCount / target));
    const rows = await sequelize.query(`
      SELECT "id" FROM (
        SELECT "id", ROW_NUMBER() OVER (ORDER BY "id") AS rn
        FROM "Logs" WHERE "sessionId" = :sessionId
      ) ranked
      WHERE (rn - 1) % :stride = 0
      ORDER BY "id"
      LIMIT :target
    `, {
      replacements: { sessionId, stride, target },
      type: sequelize.QueryTypes.SELECT,
    });
    return rows.map(r => r.id);
  }

  static async analyzeSession(req, res) {
    // Per-session single-flight guard (plans/012). validateIds('sessionId') on
    // the route already rejects non-int4 ids; this local coercion keeps the
    // controller safe for direct callers without changing the 400 ordering.
    const sid = Number(req.params.sessionId);
    if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid sessionId.' });
    if (inFlight.has(sid)) {
      return res.status(409).json({ error: 'Analysis already running for this session.' });
    }
    inFlight.add(sid);

    // Hoisted to function scope (NOT the try block): the catch below reads it,
    // and a block-scoped declaration inside try would be lexically invisible
    // there — every error reaching the catch would throw ReferenceError.
    let clientDisconnected = false;
    // Same hoisting reason for the stream accumulators: the abort path persists
    // whatever arrived before the client went away.
    let fullResponse = '';
    let fullReasoning = '';
    let finishReason = null;
    // Row identity for the abort path — unusable from the catch when declared
    // inside the try with session/settings/prompt.
    let persistContext = null;
    try {
      // 1. Ownership check — eager-loads the assigned Vehicle profile so the AI
      // prompt can describe the right car (plans/118); engineCc is not among the
      // restricted attributes because the prompt's engine guardrail needs it.
      const session = await Session.findOne({
        where: { id: req.params.sessionId, userId: req.user.id },
        include: [{ model: Vehicle, as: 'Vehicle' }],
      });
      if (!session) return res.status(404).json({ error: 'Session not found' });

      // 2. Check LLM config
      const settings = await Settings.getSingleton();
      if (!settings.llmProvider || !settings.llmApiKeyEnc) {
        return res.status(400).json({ error: 'LLM provider not configured. Set up an AI provider in Settings.' });
      }

      // 3. Discover PID keys
      const pidKeys = await discoverPidKeys(session.id, sequelize);

      // 3b. Compute session duration from LOG bounds (never createdAt —
      // backfilled uploads create the row after the trip ends, which made
      // the AI prompt show negative durations; plans/087).
      const [logBounds] = await sequelize.query(`
        SELECT MIN("timestamp") AS "startTs", MAX("timestamp") AS "endTs"
        FROM "Logs" WHERE "sessionId" = :sessionId
      `, { replacements: { sessionId: session.id } });
      const startTs = logBounds[0]?.startTs || session.firstTimestamp;
      const endTs = logBounds[0]?.endTs || session.lastTimestamp;
      const durationStr = formatSessionDuration(startTs, endTs);

      // 4. Fetch telemetry sample (first 50 + last 50 + evenly-spaced 100 for large sessions).
      //    4b's gap/peak query runs in the SAME Promise.all: it does not depend
      //    on the sample, so the second round trip overlaps the count instead
      //    of serializing behind it.
      const [countResult, gapSummary] = await Promise.all([
        sequelize.query(
          `SELECT COUNT(*) AS cnt FROM "Logs" WHERE "sessionId" = :sessionId`,
          { replacements: { sessionId: session.id } }
        ),
        AnalysisController.computeGapSummary(session.id),
      ]);
      const totalCount = parseInt(countResult[0]?.cnt || '0', 10);

      let sample;
      if (totalCount <= 400) {
        // Small session: fetch everything
        sample = await Log.findAll({
          where: { sessionId: session.id },
          attributes: ['timestamp', 'lat', 'lon', 'engine_rpm', 'vehicle_speed', 'values'],
          order: [['timestamp', 'ASC']],
          raw: true,
        });
      } else {
        // Large session: first 50 + last 50 + evenly-spaced 100 in between
        const [firstBatch, lastBatch] = await Promise.all([
          Log.findAll({
            where: { sessionId: session.id },
            attributes: ['timestamp', 'lat', 'lon', 'engine_rpm', 'vehicle_speed', 'values'],
            order: [['timestamp', 'ASC']],
            limit: 50,
            raw: true,
          }),
          Log.findAll({
            where: { sessionId: session.id },
            attributes: ['timestamp', 'lat', 'lon', 'engine_rpm', 'vehicle_speed', 'values'],
            order: [['timestamp', 'DESC']],
            limit: 50,
            raw: true,
          }),
        ]);

        // Deterministic even coverage across the whole session: the id list is
        // produced by the SQL stride selector above (bounded by LIMIT), then one
        // primary-key fetch loads the sampled rows.
        const sampledIds = await AnalysisController.selectEvenIds(session.id, totalCount);
        let randomBatch = [];
        if (sampledIds.length > 0) {
          randomBatch = await sequelize.query(
            `SELECT * FROM "Logs" WHERE id IN (:ids) ORDER BY id`,
            { replacements: { ids: sampledIds }, type: sequelize.QueryTypes.SELECT }
          );
        }
        sample = [...firstBatch, ...randomBatch, ...lastBatch];
      }

      // The sample mixes ASC (first), id-order (random), and DESC (last) batches —
      // sort chronologically so the prompt's CSV Time column is monotonic and the
      // model reads a real time series.
      sample.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // 4b. Connectivity-gap detection came from the full-resolution timestamp
      // fetch; it now runs in SQL (plans/014). detectBackfillGaps() stays the
      // reference semantics for both outputs.
      const dataQualityNote = buildDataQualityNote(gapSummary);

      // 5. Build prompt with computed duration
      const prompt = buildAnalysisPrompt(
        { ...session.toJSON(), duration: durationStr },
        settings, sample, pidKeys, dataQualityNote
      );

      // Row identity for the abort path (built before the first byte streams).
      persistContext = {
        sessionId: session.id,
        userId: req.user.id,
        provider: settings.llmProvider,
        model: settings.llmModel || 'default',
        prompt,
      };

      // 6. Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // 7. Abort as soon as the client goes away — covers prompt build +
      // provider connect, not just the mid-stream phase.
      const clientGone = new AbortController();
      req.on('close', () => { clientDisconnected = true; clientGone.abort(); });

      const { response: llmRes, abortController: llmAbort, timeoutGuard } =
        await analyze(prompt, settings);
      clientGone.signal.addEventListener('abort', () => llmAbort.abort(), { once: true });

      // Body-phase timeout is inactivity-based: every streamed event
      // (reasoning included) re-arms it; always disarm when the stream
      // finishes or throws.
      try {
        for await (const evt of streamEvents(llmRes)) {
          if (evt.type === 'finish') { finishReason = evt.reason; continue; }
          if (evt.type === 'content') fullResponse += evt.text;
          else if (evt.type === 'reasoning') fullReasoning += evt.text;
          timeoutGuard.bump();
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        }
      } finally {
        timeoutGuard.clear();
      }

      // Budget exhaustion is silent failure by design gap (plans/088): a
      // thinking-mode model can spend its whole max_tokens budget on
      // reasoning and end the stream cleanly with no answer. Warn the client
      // when the terminal reason says the stream was cut short.
      const budgetExhausted = finishReason === 'length' || finishReason === 'max_tokens';
      if (budgetExhausted) {
        const warning = !fullResponse
          ? '⚠️ The model used its entire token budget on reasoning and produced no answer. Raise \u201cMax tokens\u201d or lower \u201cReasoning effort\u201d in Settings, then retry.'
          : '⚠️ The answer was truncated \u2014 the token budget ran out mid-response. Raise \u201cMax tokens\u201d in Settings for the full analysis.';
        res.write(`data: ${JSON.stringify({ type: 'finish', reason: finishReason, warning })}\n\n`);
      }

      // 8. Cache the analysis (BEFORE signaling done so listAnalyses finds it)
      try {
        await Analysis.create({
          sessionId: session.id,
          userId: req.user.id,
          provider: settings.llmProvider,
          model: settings.llmModel || 'default',
          prompt,
          response: fullResponse || fullReasoning,
          reasoning: fullReasoning || null,
          tokenUsage: budgetExhausted ? { finishReason, reasoningChars: fullReasoning.length, responseChars: fullResponse.length } : null,
        });
      } catch (cacheErr) {
        console.error('[AnalysisController] Failed to cache analysis:', cacheErr.message);
      }
      // The row exists now; a later socket error must not write a second one.
      persistContext = null;

      if (budgetExhausted) {
        console.warn(`[AnalysisController] analyzeSession: token budget exhausted (finish=${finishReason}, reasoning=${fullReasoning.length} chars, response=${fullResponse.length} chars)`);
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      // Client gone or provider failed mid-stream: the tokens were already
      // billed, so keep the partial answer with an `aborted` marker instead of
      // discarding it. An empty stream (nothing billed) writes no row.
      const partial = fullResponse || fullReasoning;
      if (persistContext && partial) {
        try {
          await Analysis.create({
            ...persistContext,
            response: partial,
            reasoning: fullReasoning || null,
            tokenUsage: {
              ...(finishReason ? { finishReason } : {}),
              aborted: true,
              responseChars: fullResponse.length,
              reasoningChars: fullReasoning.length,
            },
          });
        } catch (cacheErr) {
          console.error('[AnalysisController] Failed to cache aborted analysis:', cacheErr.message);
        }
      }
      if (clientDisconnected) {
        console.log('[AnalysisController] analyzeSession aborted: client disconnected');
        return;
      }
      const message = classifyAnalysisError(err);
      console.error('[AnalysisController] analyzeSession error:', err);
      if (!res.headersSent) {
        res.status(502).json({ error: message });
      } else {
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        res.end();
      }
    } finally {
      inFlight.delete(sid);
    }
  }

  static async listAnalyses(req, res) {
    try {
      const session = await Session.findOne({
        where: { id: req.params.sessionId, userId: req.user.id },
      });
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const analyses = await Analysis.findAll({
        where: { sessionId: session.id, userId: req.user.id },
        order: [['createdAt', 'DESC']],
        limit: 20,
        attributes: ['id', 'provider', 'model', 'createdAt'],
      });

      res.json(analyses);
    } catch (err) {
      console.error('[AnalysisController.listAnalyses]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async deleteAnalysis(req, res) {
    try {
      const deleted = await Analysis.destroy({
        where: { id: req.params.analysisId, userId: req.user.id },
      });
      if (!deleted) return res.status(404).json({ error: 'Analysis not found' });
      res.sendStatus(200);
    } catch (err) {
      console.error('[AnalysisController.deleteAnalysis]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async listAllAnalyses(req, res) {
    try {
      // Clamp pagination to limit [1,200] (default 50) and offset >= 0.
      // limit=0 → 50 is deliberate: 0 parses falsy and falls back to the
      // default rather than being clamped up to 1 (pinned by tests).
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      // Optional vehicle filter: absent/''/'none' = no vehicle filter,
      // otherwise it must be an int4 id. Gate BEFORE Number() so junk can't
      // reach Sequelize's Session lookup as a Postgres 22P02/22003 500.
      const rawVehicleId = req.query.vehicleId;
      if (rawVehicleId !== undefined && rawVehicleId !== '' && rawVehicleId !== 'none'
          && !isInt4Id(rawVehicleId)) {
        return res.status(400).json({ error: 'Invalid vehicleId.' });
      }
      const vehicleId = rawVehicleId ? Number(rawVehicleId) : null;

      // Build where clause
      const where = { userId: req.user.id };
      if (vehicleId) {
        // Join through Session to filter by vehicle
        const sessions = await Session.findAll({
          where: { userId: req.user.id, vehicleId },
          attributes: ['id'],
        });
        where.sessionId = { [Op.in]: sessions.map(s => s.id) };
      }

      const analyses = await Analysis.findAll({
        where,
        order: [['createdAt', 'DESC']],
        limit, offset,
        attributes: ['id', 'sessionId', 'provider', 'model', 'createdAt'],
        include: [{
          model: Session,
          as: 'Session',
          attributes: ['id', 'name', 'vehicleId'],
          include: [{ model: Vehicle, as: 'Vehicle', attributes: ['id', 'name'] }],
        }],
      });

      const total = await Analysis.count({ where });
      res.json({ analyses, total, limit, offset });
    } catch (err) {
      console.error('[AnalysisController.listAllAnalyses]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async getAnalysis(req, res) {
    try {
      const analysis = await Analysis.findOne({
        where: { id: req.params.analysisId, userId: req.user.id },
        attributes: ['id', 'sessionId', 'provider', 'model', 'response', 'reasoning', 'tokenUsage', 'createdAt'],
      });
      if (!analysis) return res.status(404).json({ error: 'Analysis not found' });
      res.json(analysis);
    } catch (err) {
      console.error('[AnalysisController.getAnalysis]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  static async exportAnalyses(req, res) {
    try {
      const where = { userId: req.user.id };
      if (req.query.vehicleId) {
        const sessions = await Session.findAll({
          where: { userId: req.user.id, vehicleId: Number(req.query.vehicleId) },
          attributes: ['id'],
        });
        where.sessionId = { [Op.in]: sessions.map(s => s.id) };
      }

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="analyses.md"');
      // Backpressure: await the socket before queueing the next chunk, the same
      // idiom as SessionController.exportCsv. Without it a large history piles
      // every TEXT body into the process's write buffer at once.
      const writeChunk = async (chunk) => {
        if (!res.write(chunk)) {
          await new Promise(resolve => res.once('drain', resolve));
        }
      };
      await writeChunk('# AI Analysis History\n\n');

      // Stream rows in createdAt-DESC keyset batches (id DESC tiebreak) so at
      // most one full batch of TEXT bodies is in memory per fetch — the same
      // cursor pattern as exportCsv. Output must stay byte-identical to the
      // pre-streaming format (same per-row template, same ordering).
      const BATCH = 50;
      let cursor = null; // { createdAt, id } of the last row of the previous batch
      for (;;) {
        const batchWhere = { ...where };
        if (cursor) {
          batchWhere[Op.or] = [
            { createdAt: { [Op.lt]: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { [Op.lt]: cursor.id } },
          ];
        }

        const batch = await Analysis.findAll({
          where: batchWhere,
          order: [['createdAt', 'DESC'], ['id', 'DESC']],
          limit: BATCH,
          attributes: ['id', 'sessionId', 'provider', 'model', 'response', 'reasoning', 'createdAt'],
          include: [{ model: Session, as: 'Session', attributes: ['name'] }],
        });

        if (batch.length === 0) break;

        for (const a of batch) {
          await writeChunk(`## ${a.Session?.name || 'Unknown Session'} — ${a.createdAt.toISOString().split('T')[0]}\n\n`);
          await writeChunk(`**Provider:** ${a.provider} | **Model:** ${a.model}\n\n`);
          await writeChunk(a.response + '\n\n');
          if (a.reasoning) {
            await writeChunk('<details><summary>Reasoning</summary>\n\n');
            await writeChunk(a.reasoning + '\n\n');
            await writeChunk('</details>\n\n');
          }
          await writeChunk('---\n\n');
        }

        if (batch.length < BATCH) break;
        const last = batch[batch.length - 1];
        cursor = { createdAt: last.createdAt, id: last.id };
      }
      res.end();
    } catch (err) {
      console.error('[AnalysisController.exportAnalyses]', err);
      if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
      else res.end();
    }
  }

  static async testConnection(req, res) {
    // Testing the connection spends the admin's provider key, so it is an
    // admin-only control exactly like the Settings mutations.
    if (!requireAdmin(req, res)) return;
    try {
      const settings = await Settings.getSingleton();
      if (!settings.llmProvider || !settings.llmApiKeyEnc) {
        return res.status(400).json({ error: 'LLM provider not configured' });
      }

      // Abort as soon as the client goes away — covers prompt build +
      // provider connect, not just the mid-stream phase.
      const clientGone = new AbortController();
      req.on('close', () => clientGone.abort());

      const testPrompt = 'Say "Connection successful" and nothing else.';
      const { response: llmRes, abortController: llmAbort, timeoutGuard } =
        await analyze(testPrompt, settings, { maxTokens: 20 });
      clientGone.signal.addEventListener('abort', () => llmAbort.abort(), { once: true });

      let text = '';
      // Body-phase timeout is inactivity-based: every streamed event
      // (reasoning included) re-arms it; always disarm when the stream
      // finishes or throws.
      try {
        for await (const evt of streamEvents(llmRes)) {
          // plans/088: streamEvents now yields terminal {type:'finish'}
          // events (no text) — only append when a text chunk arrived.
          if (evt.text) text += evt.text;
          timeoutGuard.bump();
        }
      } finally {
        timeoutGuard.clear();
      }

      res.json({ ok: true, response: text.trim(), provider: settings.llmProvider });
    } catch (err) {
      console.error('[AnalysisController] testConnection error:', err);
      res.status(502).json({ ok: false, error: classifyAnalysisError(err) });
    }
  }
}

module.exports = AnalysisController;
