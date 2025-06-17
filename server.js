const express = require('express');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const fingerprint = require('./modules/fingerprint');
const visitorInfo = require('./modules/visitorinfo');
const parseDevice = require('./modules/parsdevice');

const app = express();
app.use(express.json());
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));

// ENV
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = (process.env.CHAT_IDS || '').split(',').map(id => id.trim());
const DOMAIN = process.env.DOMAIN || 'https://example.com';

// TELEGRAM
const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(`${DOMAIN}/bot${TELEGRAM_TOKEN}`);

// VISITOR DATA
const VISITORS_FILE = './visitors.json';
let visitors = {};

try {
  if (fs.existsSync(VISITORS_FILE)) {
    visitors = JSON.parse(fs.readFileSync(VISITORS_FILE));
  }
} catch (err) {
  console.error('Ошибка чтения visitors.json:', err);
}

// ROUTES
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

bot.onText(/\/stats/, (msg) => {
  const count = Object.keys(visitors).length;
  bot.sendMessage(msg.chat.id, `📊 Всего визитов: ${count}`);
});

app.get('/ping-bot', (_, res) => res.send('OK'));

app.post('/collect', async (req, res) => {
  const { fingerprint: fp, userAgent, timezone, clientTime } = req.body || {};
  const rawIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
  const ip = visitorInfo.extractIPv4(rawIp);

  if (!fp && !ip) {
    return res.status(400).json({ ok: false, error: 'Нет fingerprint и IP' });
  }

  if (visitorInfo.isGoogleIP(ip)) {
    return res.status(200).json({ ok: true, skip: 'GoogleBot IP' });
  }

  const isBot = detectBot(userAgent);
  const type = isBot ? '🤖 Бот' : '👤 Человек';

  // Парсинг устройства
  const uaData = parseDevice.parseDevice(userAgent || '');
  const geoData = await visitorInfo.getGeo(ip);
  const geoNote = geoData.cached ? '⚠️ Данные IP взяты из кэша' : '';
  const geoStr = geoData.location || 'неизвестно';

  // Определение статуса визита
  const status = visitorInfo.getVisitStatus(visitors, fp, ip);
  const visitId = fp || `ip_${ip}`;

  // Формирование отчёта
  const msgParts = [];

  if (status.status === 'new') {
    msgParts.push('🆕 НОВЫЙ ЗАХОД');
    msgParts.push(`Причина: новый fingerprint или IP`);
  } else if (status.status === 'repeat') {
    msgParts.push('♻️ ПОВТОРНЫЙ ЗАХОД');
    msgParts.push(`Шанс совпадения: ${status.score}% (${status.reason})`);
    msgParts.push(`Последний визит: ${formatDate(status.lastSeen, timezone)}`);
  } else {
    msgParts.push('❓ НЕИЗВЕСТНЫЙ ЗАХОД');
    if (!fp) msgParts.push('Причина: отсутствует fingerprint');
    if (!userAgent) msgParts.push('Причина: отсутствует User-Agent');
  }

  msgParts.push(`Тип: ${type}`);
  msgParts.push(`IP: ${ip} (${geoStr})`);
  if (geoNote) msgParts.push(geoNote);

  msgParts.push(`Fingerprint: ${fp || '—'}`);
  msgParts.push(`Устройство: ${uaData.device || 'неизвестно'}`);
  msgParts.push(`ОС: ${uaData.os || 'неизвестно'}`);
  msgParts.push(`Браузер: ${uaData.browser || 'неизвестно'}`);

  if (!userAgent) msgParts.push('⚠️ User-Agent пустой');
  if (isBot) msgParts.push('⚠️ Определён как бот по User-Agent');

  const message = msgParts.join('\n');

  // Сохранение визита
  visitors[visitId] = {
    fingerprint: fp,
    ip,
    time: new Date().toISOString(),
    userAgent,
    geo: geoStr,
    uaParsed: uaData,
  };

  try {
    fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitors, null, 2));
  } catch (err) {
    console.error('Ошибка записи visitors.json:', err);
  }

  // Отправка в Telegram
  for (const chatId of CHAT_IDS) {
    try {
      await bot.sendMessage(chatId, message);
    } catch (err) {
      console.error('Ошибка Telegram:', err);
    }
  }

  res.json({ ok: true });
});

// HELPER
function detectBot(ua) {
  if (!ua) return true;
  return /bot|crawl|spider|google|yandex|baidu|bing|duckduck/i.test(ua);
}

function formatDate(date, tz) {
  try {
    return new Date(date).toLocaleString('ru-RU', { timeZone: tz || 'UTC' });
  } catch {
    return date;
  }
}

// START
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
});
