// PostgreSQL connection helper for apgrhost
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[PostgreSQL] Не задана переменная окружения DATABASE_URL!');
  throw new Error('DATABASE_URL is not set');
}
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function logAllTables() {
  try {
    const res = await pool.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
    `);
    console.log('[PostgreSQL][DEBUG] Список таблиц:', res.rows);
  } catch (err) {
    console.error('[PostgreSQL][DEBUG] Ошибка при получении списка таблиц:', err);
  }
}

// Вызовем при старте
logAllTables();

// Создание таблицы, если не существует
async function init() {
  try {
    console.log('[PostgreSQL][DEBUG] Проверка/создание таблицы visitors...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitors (
        visitid TEXT PRIMARY KEY,
        data JSONB
      );
    `);
    console.log('[PostgreSQL][DEBUG] Таблица visitors готова.');
    await logAllTables();
  } catch (err) {
    console.error('[PostgreSQL][DEBUG] Ошибка при создании таблицы visitors:', err);
  }
}

async function saveVisitor(visitId, data) {
  await init();
  console.log('[PostgreSQL][DEBUG] saveVisitor вызван:', { visitId, data });
  if (!visitId || !data) {
    console.warn('[PostgreSQL][DEBUG] saveVisitor: пустой visitId или data');
    return;
  }
  try {
    await pool.query(
      'INSERT INTO visitors (visitid, data) VALUES ($1, $2) ON CONFLICT (visitid) DO UPDATE SET data = EXCLUDED.data',
      [visitId, data]
    );
    console.log('[PostgreSQL][DEBUG] saveVisitor: сохранено');
  } catch (err) {
    console.error('[PostgreSQL][DEBUG] Ошибка при сохранении визита:', err);
  }
}

async function getVisitor(visitId) {
  await init();
  console.log('[PostgreSQL][DEBUG] getVisitor вызван:', visitId);
  try {
    const res = await pool.query('SELECT data FROM visitors WHERE visitid = $1', [visitId]);
    console.log('[PostgreSQL][DEBUG] getVisitor результат:', res.rows[0]);
    return res.rows[0]?.data || null;
  } catch (err) {
    console.error('[PostgreSQL][DEBUG] Ошибка при getVisitor:', err);
    return null;
  }
}

async function getVisitorsCount() {
  await init();
  console.log('[PostgreSQL][DEBUG] getVisitorsCount вызван');
  try {
    const res = await pool.query('SELECT COUNT(*) FROM visitors');
    return parseInt(res.rows[0].count, 10);
  } catch (err) {
    console.error('[PostgreSQL][DEBUG] Ошибка при getVisitorsCount:', err);
    return 0;
  }
}

async function getAllVisitors() {
  await init();
  console.log('[PostgreSQL][DEBUG] getAllVisitors вызван');
  try {
    const res = await pool.query('SELECT data FROM visitors');
    console.log('[PostgreSQL][DEBUG] getAllVisitors результат:', res.rows.length);
    return res.rows.map(r => r.data);
  } catch (err) {
    console.error('[PostgreSQL][DEBUG] Ошибка при getAllVisitors:', err);
    return [];
  }
}

module.exports = {
  saveVisitor,
  getVisitor,
  getVisitorsCount,
  getAllVisitors
};
