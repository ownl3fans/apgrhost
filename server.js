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

  // --- Краткий отчет для основного сообщения ---
  let shortMsg = '';
  if (status.status === 'new') {
    shortMsg += '🆕 НОВЫЙ ЗАХОД\n';
  } else if (status.status === 'repeat') {
    shortMsg += '♻️ ПОВТОРНЫЙ ЗАХОД\n';
    shortMsg += `Шанс совпадения: ${status.score}% (${status.reason})\n`;
    shortMsg += `Последний визит: ${formatDate(status.lastSeen, timezone)}\n`;
  } else {
    shortMsg += '❓ НЕИЗВЕСТНЫЙ ЗАХОД\n';
    if (!fp) shortMsg += 'Причина: отсутствует fingerprint\n';
    if (!userAgent) shortMsg += 'Причина: отсутствует User-Agent\n';
    if (status.lastSeen) shortMsg += `Возможный визит: ${formatDate(status.lastSeen, timezone)}\n`;
  }
  shortMsg += `Тип: ${type}\n`;
  shortMsg += `IP: ${ip} — ${geoStr}\n`;
  shortMsg += `Устройство: ${uaData.device || 'неизвестно'}\n`;
  shortMsg += `Браузер: ${uaData.browser || 'неизвестно'}, ОС: ${uaData.os || 'неизвестно'}\n`;
  shortMsg += `Время: ${new Date().toLocaleTimeString('ru-RU', { timeZone: timezone || 'UTC' })}`;

  // --- Подробный отчет для второй кнопки ---
  // Собираем WebRTC IPs (если есть)
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

  let detailsMsg = '';
  detailsMsg += `Провайдер: ${geoData.org || 'неизвестно'}\n`;
  detailsMsg += `VPN/Proxy/Tor: ${(geoData.proxy || geoData.hosting) ? 'Да' : 'Нет'}\n`;
  detailsMsg += `User-Agent: ${userAgent || 'неизвестно'}\n`;
  detailsMsg += `Fingerprint: ${fp || 'неизвестно'}\n`;
  detailsMsg += `WebRTC IPs: ${webrtcIps.length ? webrtcIps.join(', ') : 'нет данных'}\n`;
  detailsMsg += `Размер экрана: ${req.body.screenSize || 'неизвестно'}\n`;
  if (req.body.width || req.body.height || req.body.platform) {
    detailsMsg += `Доп. device info: `;
    if (req.body.width) detailsMsg += `width: ${req.body.width} `;
    if (req.body.height) detailsMsg += `height: ${req.body.height} `;
    if (req.body.platform) detailsMsg += `platform: ${req.body.platform}`;
    detailsMsg += '\n';
  }

  // --- Кнопки ---
  let inlineKeyboard = [];
  // Кнопка "Проверить IP на карте"
  if (geoData.lat && geoData.lon && ip && ip !== 'неизвестно') {
    inlineKeyboard.push([
      { text: 'Проверить IP на карте', url: `https://www.google.com/maps?q=${geoData.lat},${geoData.lon}` }
    ]);
  }
  // Кнопка "Посмотреть подробнее"
  inlineKeyboard.push([
    { text: 'Посмотреть подробнее', callback_data: `details_${visitId}` }
  ]);

  // Отправка в Telegram с инлайн-кнопками
  for (const chatId of CHAT_IDS) {
    try {
      await bot.sendMessage(chatId, shortMsg, {
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
    } catch (err) {
      console.error('Ошибка Telegram:', err);
    }
  }

  // Сохраняем детали для callback (можно доработать под БД)
  visitors[visitId] = {
    fingerprint: fp,
    ip,
    time: new Date().toISOString(),
    userAgent,
    geo: geoStr,
    uaParsed: uaData,
    detailsMsg
  };

  try {
    fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitors, null, 2));
  } catch (err) {
    console.error('Ошибка записи visitors.json:', err);
  }

  res.json({ ok: true });
});

// Обработка callback кнопки "Посмотреть подробнее"
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  if (data && data.startsWith('details_')) {
    const visitId = data.replace('details_', '');
    const visit = visitors[visitId];
    if (visit && visit.detailsMsg) {
      await bot.sendMessage(chatId, visit.detailsMsg, { reply_to_message_id: query.message.message_id });
    } else {
      await bot.sendMessage(chatId, 'Детальная информация не найдена.', { reply_to_message_id: query.message.message_id });
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
