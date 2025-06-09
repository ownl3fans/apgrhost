const express = require('express');
const fs = require('fs');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const UAParser = require('ua-parser-js');
const requestIp = require('request-ip');

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DOMAIN = process.env.DOMAIN;
if (!TELEGRAM_TOKEN || !DOMAIN) {
  console.error('TELEGRAM_TOKEN и DOMAIN должны быть заданы!');
  process.exit(1);
}

const CHAT_IDS = (process.env.CHAT_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
const ADMINS = CHAT_IDS.map(id => parseInt(id)).filter(Boolean);
const VISITORS_FILE = './visitors.json';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

app.use(bodyParser.json());
app.use(requestIp.mw());
app.use(express.static('public'));

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

let visitors = {};
if (fs.existsSync(VISITORS_FILE)) {
  try {
    visitors = JSON.parse(fs.readFileSync(VISITORS_FILE, 'utf8'));
  } catch (err) {
    console.error('Ошибка чтения visitors.json:', err);
    visitors = {};
  }
}

function getTodayVisitors() {
  const today = new Date().toISOString().slice(0, 10);
  return Object.values(visitors).filter(v => v.time.startsWith(today));
}

bot.on('message', async (msg) => {
  const text = msg.text?.toLowerCase().trim();
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!ADMINS.includes(userId)) return;

  if (text === 'стата') {
    const todayVisits = getTodayVisitors();
    const total = todayVisits.length;
    const unique = new Set(todayVisits.map(v => v.fingerprint)).size;
    await bot.sendMessage(chatId, `📊 Статистика за сегодня:\nВсего визитов: ${total}\nУникальных: ${unique}`);
  }

  if (text === '/start') {
    await sendPingMessage();
    await bot.sendMessage(chatId, '✅ Сайт проверен. Пинг отправлен.');
  }
});

function getVisitStatus(fp, ip) {
  if (!fp && !ip) return { status: 'unknown' };
  const existing = Object.values(visitors).find(v => v.fingerprint === fp || v.ip === ip);
  if (existing) {
    const score = existing.ip === ip ? 100 : 60;
    return { status: 'repeat', score, lastSeen: existing.time };
  }
  return { status: 'new' };
}

function detectBot(userAgent) {
  const botSignatures = ['bot', 'crawl', 'spider', 'headless', 'python', 'curl', 'wget', 'phantomjs'];
  const lowered = userAgent?.toLowerCase() || '';
  return botSignatures.some(sig => lowered.includes(sig));
}

function guessDeviceFromUA(ua) {
  if (!ua) return 'неизвестно';
  const low = ua.toLowerCase();
  if (low.includes('iphone')) return '📱 iPhone';
  if (low.includes('ipad')) return '📱 iPad';
  if (low.includes('android')) return '📱 Android';
  if (low.includes('mobile')) return '📱 Смартфон';
  if (low.includes('tablet')) return '📱 Планшет';
  if (low.includes('windows') || low.includes('macintosh') || low.includes('linux')) return '🖥 Десктоп';
  if (low.includes('telegram')) return '📱 Telegram WebView';
  if (low.includes('tor')) return '🕳 TOR';
  return 'неизвестно';
}

async function geoLookup(ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}`);
    const data = await res.json();
    if (data.status === 'success') return `${data.query} — ${data.country}, ${data.city}`;
  } catch {}
  try {
    const res2 = await fetch(`https://ipwhois.app/json/${ip}`);
    const data2 = await res2.json();
    if (!data2.success && !data2.country) throw new Error();
    return `${data2.ip} — ${data2.country}, ${data2.city || '—'}`;
  } catch (err) {
    console.error('Geo lookup failed:', err);
    return 'Неизвестно';
  }
}

app.get('/ping-bot', async (req, res) => {
  await sendPingMessage();
  res.status(200).send('pong');
});

async function sendPingMessage() {
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' (UTC+3)';
  const ip = req.clientIp || 'неизвестно';
  const geo = await geoLookup(ip);
  const message = `📡 ПИНГ БОТ\nТип: 🤖 Пинг бот\nIP: ${geo}\nВремя: ${time}`;

  for (const chatId of CHAT_IDS) {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message })
      });
    } catch (err) {
      console.error('Ошибка Telegram:', err);
    }
  }
}

app.post('/collect', async (req, res) => {
  const { fingerprint, userAgent, device, os, browser } = req.body || {};
  const realIp = req.clientIp || 'неизвестно';

  if (!fingerprint && !realIp) {
    return res.status(400).json({ ok: false, error: 'Нет fingerprint и IP' });
  }

  let parsedUA = null;
  try {
    parsedUA = userAgent ? new UAParser(userAgent) : null;
  } catch {}

  const deviceParsed = device || (parsedUA?.getDevice().model || guessDeviceFromUA(userAgent));
  const browserParsed = browser || (parsedUA?.getBrowser().name || 'неизвестно');
  const osParsed = os || (parsedUA?.getOS().name || '');
  const statusInfo = getVisitStatus(fingerprint, realIp);
  const isBot = detectBot(userAgent);
  const type = isBot ? '🤖 Бот' : '👤 Человек';
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' (UTC+3)';
  const geo = await geoLookup(realIp);

  let message = '';
  if (statusInfo.status === 'new') {
    message += '🆕 НОВЫЙ ЗАХОД\n';
  } else if (statusInfo.status === 'repeat') {
    message += `♻️ ПОВТОРНЫЙ ЗАХОД (шанс ${statusInfo.score}%)\n`;
    message += `Последний визит: ${new Date(statusInfo.lastSeen).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (UTC+3)\n`;
  } else {
    message += '❔ НЕИЗВЕСТНЫЙ ЗАХОД\n';
  }

  message += `Тип: ${type}\nIP: ${geo}\nУстройство: ${deviceParsed}\nБраузер: ${browserParsed}, ${osParsed}\nВремя: ${time}`;

  if (statusInfo.status !== 'repeat' && fingerprint) {
    visitors[fingerprint] = { fingerprint, ip: realIp, time: new Date().toISOString() };
    try {
      fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitors, null, 2));
    } catch (err) {
      console.error('Ошибка записи visitors.json:', err);
    }
  }

  for (const chatId of CHAT_IDS) {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message })
      });
    } catch (err) {
      console.error('Telegram send error:', err);
    }
  }

  res.status(200).json({ ok: true });
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    await bot.setWebHook(`${DOMAIN}/bot${TELEGRAM_TOKEN}`);
    console.log('✅ Webhook установлен');
  } catch (err) {
    console.error('Ошибка webhook:', err);
  }
});

// Автопинг раз в 5 минут
setInterval(() => {
  fetch(`https://${DOMAIN.replace(/^https?:\/\//, '')}/ping-bot`).catch(() => {});
}, 5 * 60 * 1000);
