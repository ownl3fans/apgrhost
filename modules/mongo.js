// MongoDB connection helper for apgrhost
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
console.debug('[MongoDB][DEBUG] uri:', uri);
if (!uri) {
  console.error('[MongoDB] Не задана переменная окружения MONGODB_URI! Соединение с базой невозможно.');
  throw new Error('MONGODB_URI is not set');
}
const dbName = 'apgrhost';
const collectionName = 'visitors';

let client;
let db;
let collection;

async function connectMongo() {
  if (collection) {
    console.debug('[MongoDB][DEBUG] Повторное использование существующего подключения.');
    return collection;
  }
  try {
    console.debug('[MongoDB][DEBUG] Попытка подключения к MongoDB...');
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
    collection = db.collection(collectionName);
    console.log('[MongoDB] Успешное подключение к базе данных!');
    return collection;
  } catch (err) {
    console.error('[MongoDB] Ошибка подключения:', err);
    throw err;
  }
}

async function saveVisitor(visitId, data) {
  const col = await connectMongo();
  if (!visitId) {
    console.error('[MongoDB] saveVisitor: visitId is empty!', data);
    return;
  }
  if (!data) {
    console.error('[MongoDB] saveVisitor: data is empty!');
    return;
  }
  try {
    console.debug('[MongoDB][DEBUG] saveVisitor: попытка сохранить', { visitId, data });
    await col.updateOne({ visitId }, { $set: { ...data, visitId } }, { upsert: true });
    console.log(`[MongoDB] saveVisitor: сохранён visitId=${visitId}`);
  } catch (err) {
    console.error('[MongoDB] saveVisitor: ошибка при сохранении:', err, data);
  }
}

async function getVisitor(visitId) {
  const col = await connectMongo();
  console.debug('[MongoDB][DEBUG] getVisitor:', visitId);
  return await col.findOne({ visitId });
}

async function getVisitorsCount() {
  const col = await connectMongo();
  console.debug('[MongoDB][DEBUG] getVisitorsCount');
  return await col.countDocuments();
}

async function getAllVisitors() {
  const col = await connectMongo();
  console.debug('[MongoDB][DEBUG] getAllVisitors');
  return await col.find({}).toArray();
}

module.exports = {
  saveVisitor,
  getVisitor,
  getVisitorsCount,
  getAllVisitors
};
