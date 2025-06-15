const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const requestIp = require('request-ip');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));

// === Переменные окружения ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = (process.env.CHAT_IDS || '').split(',').map(id => id.trim());
const DOMAIN = process.env.DOMAIN || 'https://example.com';

// === Telegram Bot ===
const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(`${DOMAIN}/bot${TELEGRAM_TOKEN}`);

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, 'Бот работает и принимает события с сайта.');
});

bot.onText(/\/stats/, msg => {
  const count = Object.keys(visitors).length;
  bot.sendMessage(msg.chat.id, `👀 Всего визитов: ${count}`);
});

app.get('/ping-bot', (req, res) => res.sendStatus(200));

// === Хранилище визитов ===
const VISITORS_FILE = './visitors.json';
let visitors = {};
try {
  if (fs.existsSync(VISITORS_FILE)) {
    visitors = JSON.parse(fs.readFileSync(VISITORS_FILE));
  }
} catch (err) {
  console.error('Ошибка чтения visitors.json:', err);
}

// === Утилиты ===
function extractIPv4(ip) {
  if (!ip) return '';
  const first = (ip.split(',')[0] || '').trim();
  return first.includes(':') ? first.split(':').pop() : first;
}

function detectBot(ua) {
  if (!ua) return true;
  return /bot|crawl|spider|google|yandex|baidu|bing|duckduck/i.test(ua.toLowerCase());
}

const googleIpRanges = [/^66\.249\./, /^64\.233\./, /^72\.14\./, /^203\.208\./, /^216\.239\./];
function isGoogleIP(ip) {
  return googleIpRanges.some(rx => rx.test(ip));
}

const geoCache = new Map();
const uaCache = new Map();

async function getGeo(ip) {
  if (geoCache.has(ip)) return geoCache.get(ip) + ' (кэш)';
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city,query`);
    const data = await res.json();
    if (data.status === 'success') {
      const geo = `${data.query} (${data.country}, ${data.city})`;
      geoCache.set(ip, geo);
      return geo;
    }
  } catch {}
  try {
    const res = await fetch(`https://ipwhois.app/json/${ip}`);
    const data = await res.json();
    if (data.success !== false) {
      const geo = `${data.ip} (${data.country}, ${data.city})`;
      geoCache.set(ip, geo);
      return geo;
    }
  } catch {}
  geoCache.set(ip, `${ip} (не определено)`);
  return `${ip} (не определено)`;
}

async function getBrowserDataFromAPI(userAgent) {
  if (!userAgent) return { browser: 'неизвестно', os: 'неизвестно', device: 'неизвестно' };
  if (uaCache.has(userAgent)) return { ...uaCache.get(userAgent), cached: true };

  const apiKey = 'faab5f7aef335ee5e5e82e6d6f9e077a';
  try {
    const res = await fetch('https://api.whatismybrowser.com/api/v3/detect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey
      },
      body: JSON.stringify({ user_agent: userAgent })
    });
    const json = await res.json();
    const result = json?.result?.parsed;

    const browser = result?.browser_name || 'неизвестно';
    const os = result?.operating_system_name || 'неизвестно';

    const parsed = {
      browser: browser,
      os: os,
      device: result?.simple_sub_description || result?.hardware_type || 'неизвестно'
    };
    uaCache.set(userAgent, parsed);
    return parsed;
  } catch (err) {
    console.error('Ошибка парсинга UA API:', err);
    return { browser: 'неизвестно', os: 'неизвестно', device: 'неизвестно' };
  }
}

function getVisitStatus(fingerprint, ip) {
  const id = fingerprint || `ip_${ip}`;
  const entry = visitors[id];
  if (!entry) return { status: 'new' };

  const now = Date.now();
  const last = new Date(entry.time).getTime();
  const diff = (now - last) / 1000;

  const sameIP = entry.ip === ip;
  const score = fingerprint ? (sameIP ? 100 : 70) : 50;
  const reason = fingerprint
    ? (sameIP ? 'Fingerprint + IP' : 'Fingerprint совпал')
    : 'Только IP';

  return {
    status: 'repeat',
    score,
    reason,
    lastSeen: entry.time
  };
}

// === Обработка визита ===
app.post('/collect', async (req, res) => {
  const { fingerprint, userAgent } = req.body || {};
  const rawIp = requestIp.getClientIp(req) || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ip = extractIPv4(rawIp);

  if (!ip && !fingerprint) return res.sendStatus(400);

  if (isGoogleIP(ip)) return res.sendStatus(200);

  const lowerUA = (userAgent || '').toLowerCase();
  const isCrawler = [
    'googlebot', 'bingbot', 'yandexbot', 'duckduckbot',
    'baiduspider', 'slurp', 'facebot', 'twitterbot', 'linkedinbot'
  ].some(bot => lowerUA.includes(bot));

  if (isCrawler) return res.sendStatus(200);

  const geo = await getGeo(ip);
  const uaResult = await getBrowserDataFromAPI(userAgent);
  const visit = getVisitStatus(fingerprint, ip);

  const isBot = detectBot(userAgent);
  const type = isBot ? '🤖 Бот' : '👤 Человек';
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU');
  const timeStr = now.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' });

  let msg = '';

  if (visit.status === 'new') {
    msg += '🆕 НОВЫЙ ЗАХОД\n';
  } else if (visit.status === 'repeat') {
    msg += `♻️ ПОВТОРНЫЙ ЗАХОД\nШанс: ${visit.score}% (${visit.reason})\n`;
    msg += `Последний визит: ${new Date(visit.lastSeen).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}\n`;
  } else {
    msg += `❔ НЕИЗВЕСТНЫЙ ЗАХОД\nПричина: ${visit.reason || 'не определено'}\n`;
  }

  msg += `Тип: ${type}\n`;
  msg += `IP: ${geo}\n`;

  msg += uaResult.device !== 'неизвестно'
    ? `Устройство: ${uaResult.device}\n`
    : `Устройство: не определено (User-Agent: ${userAgent || 'пустой'})\n`;

  const browserLine = `${uaResult.browser}, ${uaResult.os}`;
  msg += browserLine !== 'неизвестно, неизвестно'
    ? `Браузер: ${browserLine}\n`
    : `Браузер: не определён (User-Agent: ${userAgent || 'пустой'})\n`;

  msg += `Fingerprint: ${fingerprint || 'нет'}\n`;
  msg += `Время: ${timeStr} (UTC+3)`;
  if (uaResult.cached) msg += `\n🗂 Данные из кэша`;

  for (const id of CHAT_IDS) {
    try {
      await bot.sendMessage(id, msg);
    } catch (err) {
      console.error('Ошибка отправки в Telegram:', err);
    }
  }

  visitors[fingerprint || `ip_${ip}`] = {
    time: new Date().toISOString(),
    fingerprint,
    ip,
    userAgent,
    ...uaResult
  };

  try {
    fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitors, null, 2));
  } catch (err) {
    console.error('Ошибка записи visitors.json:', err);
  }

  res.sendStatus(200);
});

// === Запуск сервера ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
