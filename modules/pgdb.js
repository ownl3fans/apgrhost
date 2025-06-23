// PostgreSQL connection helper for apgrhost
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[PostgreSQL] Не задана переменная окружения DATABASE_URL!');
  throw new Error('DATABASE_URL is not set');
}
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

// Создание таблицы, если не существует
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visitors (
      visitid TEXT PRIMARY KEY,
      data JSONB
    );
  `);
}

async function saveVisitor(visitId, data) {
  await init();
  if (!visitId || !data) return;
  await pool.query(
    'INSERT INTO visitors (visitid, data) VALUES ($1, $2) ON CONFLICT (visitid) DO UPDATE SET data = EXCLUDED.data',
    [visitId, data]
  );
}

async function getVisitor(visitId) {
  await init();
  const res = await pool.query('SELECT data FROM visitors WHERE visitid = $1', [visitId]);
  return res.rows[0]?.data || null;
}

async function getVisitorsCount() {
  await init();
  const res = await pool.query('SELECT COUNT(*) FROM visitors');
  return parseInt(res.rows[0].count, 10);
}

async function getAllVisitors() {
  await init();
  const res = await pool.query('SELECT data FROM visitors');
  return res.rows.map(r => r.data);
}

module.exports = {
  saveVisitor,
  getVisitor,
  getVisitorsCount,
  getAllVisitors
};
