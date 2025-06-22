// MongoDB connection helper for apgrhost
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
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
  if (collection) return collection;
  try {
    client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
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
  await col.updateOne({ visitId }, { $set: { ...data, visitId } }, { upsert: true });
}

async function getVisitor(visitId) {
  const col = await connectMongo();
  return await col.findOne({ visitId });
}

async function getVisitorsCount() {
  const col = await connectMongo();
  return await col.countDocuments();
}

async function getAllVisitors() {
  const col = await connectMongo();
  return await col.find({}).toArray();
}

module.exports = {
  saveVisitor,
  getVisitor,
  getVisitorsCount,
  getAllVisitors
};
