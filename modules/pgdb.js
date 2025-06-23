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
  console.log('[PostgreSQL][DEBUG] Проверка/создание таблицы visitors...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visitors (
      visitid TEXT PRIMARY KEY,
      data JSONB
    );
  `);
  console.log('[PostgreSQL][DEBUG] Таблица visitors готова.');
}

async function saveVisitor(visitId, data) {
  await init();
  console.log('[PostgreSQL][DEBUG] saveVisitor вызван:', { visitId, data });
  if (!visitId || !data) {
    console.warn('[PostgreSQL][DEBUG] saveVisitor: пустой visitId или data');
    return;
  }
  await pool.query(
    'INSERT INTO visitors (visitid, data) VALUES ($1, $2) ON CONFLICT (visitid) DO UPDATE SET data = EXCLUDED.data',
    [visitId, data]
  );
  console.log('[PostgreSQL][DEBUG] saveVisitor: сохранено');
}

async function getVisitor(visitId) {
  await init();
  console.log('[PostgreSQL][DEBUG] getVisitor вызван:', visitId);
  const res = await pool.query('SELECT data FROM visitors WHERE visitid = $1', [visitId]);
  console.log('[PostgreSQL][DEBUG] getVisitor результат:', res.rows[0]);
  return res.rows[0]?.data || null;
}

async function getVisitorsCount() {
  await init();
  console.log('[PostgreSQL][DEBUG] getVisitorsCount вызван');
  const res = await pool.query('SELECT COUNT(*) FROM visitors');
  return parseInt(res.rows[0].count, 10);
}

async function getAllVisitors() {
  await init();
  console.log('[PostgreSQL][DEBUG] getAllVisitors вызван');
  const res = await pool.query('SELECT data FROM visitors');
  console.log('[PostgreSQL][DEBUG] getAllVisitors результат:', res.rows.length);
  return res.rows.map(r => r.data);
}

module.exports = {
  saveVisitor,
  getVisitor,
  getVisitorsCount,
  getAllVisitors
};
