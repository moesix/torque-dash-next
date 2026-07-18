const Session = require('../models').Session;
const Log = require('../models').Log;
const Analysis = require('../models').Analysis;
const Settings = require('../models').Settings;
const sequelize = require('../models').sequelize;
const { analyze } = require('../lib/llmProviders');
const { buildAnalysisPrompt } = require('../lib/llmPrompt');

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
      const [keyRows] = await sequelize.query(`
        SELECT DISTINCT key FROM (
          SELECT jsonb_object_keys(values) AS key
          FROM "Logs" WHERE "sessionId" = :sessionId
        ) sub
        WHERE key ~ '^k' AND length(key) > 1
        ORDER BY key
      `, { replacements: { sessionId: session.id } });
      const pidKeys = keyRows.map(r => r.key);

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

      // 4. Fetch telemetry sample (first 50 + last 50 + random 100 for large sessions)
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
        // Large session: first 50 + last 50 + random 100 in between
        const [firstBatch, lastBatch, randomBatch] = await Promise.all([
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
          /* Random 100 via raw SQL — Sequelize doesn't have ORDER BY RANDOM() */
          sequelize.query(`
            SELECT "timestamp", lat, lon, engine_rpm, vehicle_speed, values
            FROM "Logs"
            WHERE "sessionId" = :sessionId
            ORDER BY random()
            LIMIT 100
          `, { replacements: { sessionId: session.id }, type: sequelize.QueryTypes.SELECT }),
        ]);
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

      // 7. Call LLM and stream response
      const { response: llmRes, abortController: llmAbort } = await analyze(prompt, settings);

      // Cancel LLM API call if client disconnects mid-stream (saves cost)
      req.on('close', () => {
        llmAbort.abort();
      });

      const reader = llmRes.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';
      let fullReasoning = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            break;
          }
          try {
            const parsed = JSON.parse(data);
            // OpenAI-style: choices[0].delta.content
            const delta = parsed.choices?.[0]?.delta?.content;
            // DeepSeek reasoning models: content is null, text comes via reasoning_content
            const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
            // Anthropic-style: delta.text from content_block_delta events
            const text = delta || reasoning || parsed.delta?.text;
            if (text) {
              if (delta) {
                fullResponse += text;
              } else if (reasoning) {
                fullReasoning += text;
              } else {
                // Anthropic-style (no delta/reasoning distinction) — treat as content
                fullResponse += text;
              }
              const type = delta ? 'content' : (reasoning ? 'reasoning' : 'content');
              res.write(`data: ${JSON.stringify({ type, text })}\n\n`);
            }
          } catch {
            // Skip malformed chunks
          }
        }
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
      console.error('[AnalysisController.analyzeSession]', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Analysis failed' });
      } else {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
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
        attributes: ['id', 'provider', 'model', 'response', 'reasoning', 'tokenUsage', 'createdAt'],
      });

      res.json(analyses);
    } catch (err) {
      console.error('[AnalysisController.listAnalyses]', err);
      res.sendStatus(500);
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
      res.sendStatus(500);
    }
  }

  static async testConnection(req, res) {
    try {
      const settings = await Settings.getSingleton();
      if (!settings.llmProvider || !settings.llmApiKeyEnc) {
        return res.status(400).json({ error: 'LLM provider not configured' });
      }

      const testPrompt = 'Say "Connection successful" and nothing else.';
      const { response: llmRes } = await analyze(testPrompt, settings, { maxTokens: 20 });

      const reader = llmRes.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
            const chunk = delta || reasoning || parsed.delta?.text;
            if (chunk) text += chunk;
          } catch {}
        }
      }

      res.json({ ok: true, response: text.trim(), provider: settings.llmProvider });
    } catch (err) {
      console.error('[AnalysisController.testConnection]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
}

module.exports = AnalysisController;
