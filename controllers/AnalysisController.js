const { Op } = require('sequelize');
const Session = require('../models').Session;
const Log = require('../models').Log;
const Analysis = require('../models').Analysis;
const Vehicle = require('../models').Vehicle;
const Settings = require('../models').Settings;
const sequelize = require('../models').sequelize;
const { analyze, streamEvents } = require('../lib/llmProviders');
const { buildAnalysisPrompt } = require('../lib/llmPrompt');
const { discoverPidKeys } = require('../lib/pidRegistry');

class AnalysisController {
  static async analyzeSession(req, res) {
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

      // 3b. Compute session duration from createdAt to last log timestamp
      const [lastLog] = await sequelize.query(`
        SELECT MAX("timestamp") AS "endTs" FROM "Logs" WHERE "sessionId" = :sessionId
      `, { replacements: { sessionId: session.id } });
      const endTs = lastLog[0]?.endTs || session.updatedAt;
      const durationMs = new Date(endTs) - new Date(session.createdAt);
      const durationSec = Math.floor(durationMs / 1000);
      const hours = Math.floor(durationSec / 3600);
      const minutes = Math.floor((durationSec % 3600) / 60);
      const seconds = durationSec % 60;
      const durationStr = [hours, minutes, seconds].map(n => String(n).padStart(2, '0')).join(':');

      // 4. Fetch telemetry sample (first 50 + last 50 + evenly-spaced 100 for large sessions)
      const [countResult] = await sequelize.query(
        `SELECT COUNT(*) AS cnt FROM "Logs" WHERE "sessionId" = :sessionId`,
        { replacements: { sessionId: session.id } }
      );
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

      // 5. Build prompt with computed duration
      const prompt = buildAnalysisPrompt(
        { ...session.toJSON(), duration: durationStr },
        settings, sample, pidKeys
      );

      // 6. Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // 7. Abort as soon as the client goes away — covers prompt build +
      // provider connect, not just the mid-stream phase.
      const clientGone = new AbortController();
      req.on('close', () => clientGone.abort());

      const { response: llmRes, abortController: llmAbort, timeout } =
        await analyze(prompt, settings);
      clientGone.signal.addEventListener('abort', () => llmAbort.abort(), { once: true });

      let fullResponse = '';
      let fullReasoning = '';

      // The 120s provider timeout stays armed through the whole body read;
      // always disarm it when streaming finishes or throws.
      try {
        for await (const evt of streamEvents(llmRes)) {
          if (evt.type === 'content') fullResponse += evt.text;
          else if (evt.type === 'reasoning') fullReasoning += evt.text;
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        }
      } finally {
        clearTimeout(timeout);
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
          tokenUsage: null,
        });
      } catch (cacheErr) {
        console.error('[AnalysisController] Failed to cache analysis:', cacheErr.message);
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      console.error('[AnalysisController] analyzeSession error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Analysis failed' });
      } else {
        res.write(`data: ${JSON.stringify({ error: 'Analysis failed' })}\n\n`);
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
      const { response: llmRes, abortController: llmAbort, timeout } =
        await analyze(testPrompt, settings, { maxTokens: 20 });
      clientGone.signal.addEventListener('abort', () => llmAbort.abort(), { once: true });

      let text = '';
      // The 120s provider timeout stays armed through the whole body read;
      // always disarm it when streaming finishes or throws.
      try {
        for await (const evt of streamEvents(llmRes)) {
          text += evt.text;
        }
      } finally {
        clearTimeout(timeout);
      }

      res.json({ ok: true, response: text.trim(), provider: settings.llmProvider });
    } catch (err) {
      console.error('[AnalysisController] testConnection error:', err);
      res.status(500).json({ ok: false, error: 'LLM connection test failed' });
    }
  }
}

module.exports = AnalysisController;
