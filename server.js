// ============================================================
//  Agent DB API — Secure write endpoint for agent data
//  Tables: agent_user_profiles, agent_usecase_events
// ============================================================

const express = require('express');
const { Pool }  = require('pg');
const cors      = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

const API_KEY = process.env.AGENT_API_KEY || 'agent-secret-key-change-me';

function requireApiKey(req, res, next) {
  const key = req.headers['x-agent-api-key'] || req.query.apiKey;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

app.post('/api/profile', requireApiKey, async (req, res) => {
  const { userId, sessionId, municipalityId, displayName, email, role, lastUsecase, snapshot, metadata } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const result = await pool.query(`
      INSERT INTO agent_user_profiles
        (user_id, session_id, municipality_id, display_name, email, role, last_usecase, last_active_at, snapshot, metadata, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        session_id=COALESCE(EXCLUDED.session_id,agent_user_profiles.session_id),
        municipality_id=COALESCE(EXCLUDED.municipality_id,agent_user_profiles.municipality_id),
        display_name=COALESCE(EXCLUDED.display_name,agent_user_profiles.display_name),
        email=COALESCE(EXCLUDED.email,agent_user_profiles.email),
        role=COALESCE(EXCLUDED.role,agent_user_profiles.role),
        last_usecase=COALESCE(EXCLUDED.last_usecase,agent_user_profiles.last_usecase),
        last_active_at=NOW(),
        snapshot=COALESCE(EXCLUDED.snapshot,agent_user_profiles.snapshot),
        metadata=COALESCE(EXCLUDED.metadata,agent_user_profiles.metadata),
        updated_at=NOW()
      RETURNING *
    `, [userId, sessionId, municipalityId, displayName, email, role||'user', lastUsecase,
        snapshot?JSON.stringify(snapshot):null, metadata?JSON.stringify(metadata):null]);
    res.json({ ok: true, profile: result.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/event', requireApiKey, async (req, res) => {
  const { userId, sessionId, usecase, eventType, payload, status, errorMessage, durationMs } = req.body;
  if (!userId || !usecase || !eventType)
    return res.status(400).json({ error: 'userId, usecase, eventType required' });
  try {
    const result = await pool.query(`
      INSERT INTO agent_usecase_events
        (user_id, session_id, usecase, event_type, payload, status, error_message, duration_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at
    `, [userId, sessionId, usecase, eventType,
        payload?JSON.stringify(payload):'{}', status||'ok', errorMessage||null, durationMs||null]);
    res.json({ ok: true, id: result.rows[0].id, ts: result.rows[0].created_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/batch', requireApiKey, async (req, res) => {
  const { events } = req.body;
  if (!Array.isArray(events)||!events.length) return res.status(400).json({ error: 'events[] required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = [];
    for (const ev of events) {
      const r = await client.query(`
        INSERT INTO agent_usecase_events
          (user_id, session_id, usecase, event_type, payload, status, error_message, duration_ms)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
      `, [ev.userId,ev.sessionId,ev.usecase,ev.eventType,
          ev.payload?JSON.stringify(ev.payload):'{}',ev.status||'ok',ev.errorMessage||null,ev.durationMs||null]);
      ids.push(r.rows[0].id);
    }
    await client.query('COMMIT');
    res.json({ ok: true, inserted: ids.length, ids });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.get('/api/profile/:userId', requireApiKey, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM agent_user_profiles WHERE user_id=$1', [req.params.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/events/:userId', requireApiKey, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit)||50, 500);
  try {
    const r = await pool.query(
      'SELECT * FROM agent_usecase_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2',
      [req.params.userId, limit]);
    res.json({ events: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Agent DB API running on port ${PORT}`));
