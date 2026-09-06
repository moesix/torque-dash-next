const { Op } = require('sequelize');
const Session = require('../models').Session;
const Log = require('../models').Log;
const Analysis = require('../models').Analysis;
const Vehicle = require('../models').Vehicle;
const Settings = require('../models').Settings;
const sequelize = require('../models').sequelize;
const { analyze, streamEvents } = require('../lib/llmProviders');
const { buildAnalysisPrompt, formatSessionDuration, detectBackfillGaps, buildDataQualityNote } = require('../lib/llmPrompt');
const { discoverPidKeys } = require('../lib/pidRegistry');
const { classifyAnalysisError } = require('../lib/analysisErrors');

class AnalysisController {
  static async analyzeSession(req, res) {
    // Hoisted to function scope (NOT the try block): the catch below reads it,
    // and a block-scoped declaration inside try would be lexically invisible
    // there — every error reaching the catch would throw ReferenceError.
    let clientDisconnected = false;
    try {
      // 1. Ownership check
      const session = await Session.findOne({
        where: { id: req.params.sessionId, userId: req.user.id },
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
      //    The 4b timestamp scan is kicked off in the SAME Promise.all: it does not
      //    depend on the sample, and running it alongside the count keeps the
      //    full-session timestamp transfer off the serial critical path.
      const [countResult, tsRows] = await Promise.all([
        sequelize.query(
          `SELECT COUNT(*) AS cnt FROM "Logs" WHERE "sessionId" = :sessionId`,
          { replacements: { sessionId: session.id } }
        ),
        // detectBackfillGaps() sorts internally — no ORDER BY needed here.
        sequelize.query(
          `SELECT timestamp FROM "Logs" WHERE "sessionId" = :sessionId`,
          { replacements: { sessionId: session.id }, type: sequelize.QueryTypes.SELECT }
        ),
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

        // Deterministic even coverage across the whole session: index-only id scan,
        // evenly-spaced pick in JS, then one primary-key fetch for the sampled rows.
        const idRows = await sequelize.query(
          `SELECT id FROM "Logs" WHERE "sessionId" = :sessionId ORDER BY id`,
          { replacements: { sessionId: session.id }, type: sequelize.QueryTypes.SELECT }
        );
        const ids = idRows.map(r => r.id);
        const target = Math.min(100, ids.length);
        const step = Math.max(1, Math.floor(ids.length / target));
        const sampledIds = [];
        for (let i = 0; i < ids.length && sampledIds.length < target; i += step) {
          sampledIds.push(ids[i]);
        }
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

      // 4b. Connectivity-gap detection from the full-resolution timestamps fetched
      // in parallel with the count above (detectBackfillGaps sorts internally).
      const gapResult = detectBackfillGaps(tsRows.map(r => r.timestamp));
      const dataQualityNote = buildDataQualityNote(gapResult);

      // 5. Build prompt with computed duration
      const prompt = buildAnalysisPrompt(
        { ...session.toJSON(), duration: durationStr },
        settings, sample, pidKeys, dataQualityNote
      );

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

      let fullResponse = '';
      let fullReasoning = '';
      let finishReason = null;

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

      if (budgetExhausted) {
        console.warn(`[AnalysisController] analyzeSession: token budget exhausted (finish=${finishReason}, reasoning=${fullReasoning.length} chars, response=${fullResponse.length} chars)`);
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
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
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const offset = parseInt(req.query.offset, 10) || 0;
      const vehicleId = req.query.vehicleId ? Number(req.query.vehicleId) : null;

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
        attributes: ['id', 'sessionId', 'provider', 'model', 'response', 'reasoning', 'createdAt'],
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

      const analyses = await Analysis.findAll({
        where,
        order: [['createdAt', 'DESC']],
        attributes: ['id', 'sessionId', 'provider', 'model', 'response', 'reasoning', 'createdAt'],
        include: [{ model: Session, as: 'Session', attributes: ['name'] }],
      });

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="analyses.md"');
      res.write('# AI Analysis History\n\n');

      for (const a of analyses) {
        res.write(`## ${a.Session?.name || 'Unknown Session'} — ${a.createdAt.toISOString().split('T')[0]}\n\n`);
        res.write(`**Provider:** ${a.provider} | **Model:** ${a.model}\n\n`);
        res.write(a.response + '\n\n');
        if (a.reasoning) {
          res.write('<details><summary>Reasoning</summary>\n\n');
          res.write(a.reasoning + '\n\n');
          res.write('</details>\n\n');
        }
        res.write('---\n\n');
      }
      res.end();
    } catch (err) {
      console.error('[AnalysisController.exportAnalyses]', err);
      if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
      else res.end();
    }
  }

  static async testConnection(req, res) {
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
