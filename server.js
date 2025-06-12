const express = require('express');
const fs = require('fs');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const UAParser = require('ua-parser-js');
const cors = require('cors');

const app = express();
app.set('trust proxy', true); // Важно для правильного IP в Render и других прокси

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DOMAIN = process.env.DOMAIN;

if (!TELEGRAM_TOKEN || !DOMAIN) {
  console.error('❌ TELEGRAM_TOKEN и DOMAIN обязательны!');
  process.exit(1);
}

const CHAT_IDS = (process.env.CHAT_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);
const ADMINS = CHAT_IDS.map(id => parseInt(id)).filter(Boolean);
const VISITORS_FILE = './visitors.json';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

let visitors = {};
if (fs.existsSync(VISITORS_FILE)) {
  try {
    visitors = JSON.parse(fs.readFileSync(VISITORS_FILE, 'utf8'));
  } catch (err) {
    console.error('Ошибка чтения visitors.json:', err);
    visitors = {};
  }
}

// ---------------- ВСПОМОГАТЕЛЬНЫЕ ----------------

function extractIPv4(ipString) {
  if (!ipString) return '';
  const ips = ipString.split(',').map(i => i.trim());
  for (const ip of ips) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  }
  return ips[0] || '';
}

function getVisitStatus(fp, ip) {
  if (!fp && !ip) return { status: 'unknown' };
  const existing = Object.values(visitors).find(v => v.fingerprint === fp || v.ip === ip);
  if (existing) {
    const score = existing.ip === ip ? 100 : 60;
    return { status: 'repeat', score, lastSeen: existing.time };
  }
  return { status: 'new' };
}

function detectBot(ua) {
  const botKeywords = ['bot', 'crawl', 'spider', 'headless', 'python', 'curl', 'wget'];
  return botKeywords.some(k => ua?.toLowerCase().includes(k));
}

function guessDeviceFromUA(ua) {
  if (!ua) return 'неизвестно';
  const low = ua.toLowerCase();
  if (low.includes('iphone')) return '📱 iPhone';
  if (low.includes('ipad')) return '📱 iPad';
  if (low.includes('android')) return '📱 Android';
  if (low.includes('mobile')) return '📱 Смартфон';
  if (low.includes('tablet')) return '📱 Планшет';
  if (low.includes('telegram')) return '📱 Telegram WebView';
  if (low.includes('windows') || low.includes('macintosh') || low.includes('linux')) return '🖥 Десктоп';
  if (low.includes('tor')) return '🕳 TOR';
  return 'неизвестно';
}

function getDeviceBrand(ua) {
  if (/iPhone/.test(ua)) return 'Apple iPhone';
  if (/iPad/.test(ua)) return 'Apple iPad';
  if (/SM-|Samsung/.test(ua)) return 'Samsung';
  if (/Redmi|Xiaomi|Mi/.test(ua)) return 'Xiaomi';
  if (/POCO/.test(ua)) return 'POCO';
  if (/Pixel/.test(ua)) return 'Google Pixel';
  if (/Huawei|HONOR/.test(ua)) return 'Huawei/Honor';
  if (/OnePlus/.test(ua)) return 'OnePlus';
  if (/Realme/.test(ua)) return 'Realme';
  if (/Motorola|Moto/.test(ua)) return 'Motorola';
  if (/Nokia/.test(ua)) return 'Nokia';
  if (/Sony/.test(ua)) return 'Sony';
  if (/LG/.test(ua)) return 'LG';
  if (/HTC/.test(ua)) return 'HTC';
  if (/ZTE/.test(ua)) return 'ZTE';
  if (/Oppo/.test(ua)) return 'Oppo';
  return null;
}

async function getIPGeo(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return 'Неизвестно';
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}`);
    const data = await res.json();
    if (data?.status === 'success') return `${data.query} — ${data.country}, ${data.city}`;
  } catch {}
  try {
    const res = await fetch(`https://ipwhois.app/json/${ip}`);
    const data = await res.json();
    if (data?.ip) return `${data.ip} — ${data.country}, ${data.city}`;
  } catch {}
  return 'Неизвестно';
}

// ---------------- ТЕЛЕГРАМ-БОТ ----------------

app.post(`/bot${TELEGRAM_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim().toLowerCase();
  const userId = msg.from.id;

  if (!ADMINS.includes(userId)) return;

  if (text === '/start') {
    const res = await fetch(`${DOMAIN}/ping-bot`);
    await bot.sendMessage(chatId, res.ok ? '✅ Сайт пингуется.' : '❌ Ошибка пинга.');
  }

  if (text === 'стата') {
    const today = new Date().toISOString().split('T')[0];
    const todayVisitors = Object.values(visitors).filter(v => v.time.startsWith(today));
    const unique = new Set(todayVisitors.map(v => v.fingerprint)).size;
    await bot.sendMessage(chatId, `📊 Статистика за сегодня:\nВсего визитов: ${todayVisitors.length}\nУникальных: ${unique}`);
  }
});

app.get('/ping-bot', async (req, res) => {
  const ip = extractIPv4(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');
  const ua = req.headers['user-agent'] || '';
  const geo = await getIPGeo(ip);
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' });

  const msg = `📡 ПИНГ-БОТ\nТип: 🤖 Бот\nIP: ${geo}\nВремя: ${time} (UTC+3)`;
  for (const chatId of CHAT_IDS) {
    try {
      await bot.sendMessage(chatId, msg);
    } catch (err) {
      console.error('Ошибка Telegram:', err);
    }
  }

  res.status(200).send('pong');
});

// ---------------- СОБОР ДАННЫХ ----------------

app.post('/collect', async (req, res) => {
  const {
    fingerprint,
    ip,
    userAgent,
    device,
    os,
    browser,
    memory,
    cpu,
  } = req.body || {};

  const realIp = extractIPv4(ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress);

  if (!fingerprint && !realIp) {
    return res.status(400).json({ ok: false, error: 'Нет fingerprint или IP' });
  }

  let parsedUA = null;
  try {
    parsedUA = userAgent ? new UAParser(userAgent) : null;
  } catch {}

  const brand = getDeviceBrand(userAgent || '');
  const model = parsedUA?.getDevice().model || '';
  const deviceParsed = device || (brand ? `${brand} ${model}`.trim() : model || guessDeviceFromUA(userAgent));
  const browserParsed = browser || parsedUA?.getBrowser().name || 'неизвестно';
  const osParsed = os || parsedUA?.getOS().name || 'неизвестно';

  const statusInfo = getVisitStatus(fingerprint, realIp);
  const isBot = detectBot(userAgent);
  const type = isBot ? '🤖 Бот' : '👤 Человек';
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' });
  const geo = await getIPGeo(realIp);

  let message = '';
  if (statusInfo.status === 'new') message += '🆕 НОВЫЙ ЗАХОД\n';
  else if (statusInfo.status === 'repeat') {
    message += `♻️ ПОВТОРНЫЙ ЗАХОД (шанс ${statusInfo.score}%)\n`;
    message += `Последний визит: ${new Date(statusInfo.lastSeen).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (UTC+3)\n`;
  } else message += '❔ НЕИЗВЕСТНЫЙ ЗАХОД\n';

  message += `Тип: ${type}\n`;
  message += `IP: ${geo}\n`;
  message += `Устройство: ${deviceParsed}\n`;
  message += `Браузер: ${browserParsed}, ${osParsed}\n`;
  if (memory || cpu) {
    message += `RAM: ${memory || 'неизвестно'} ГБ, CPU: ${cpu || 'неизвестно'} ядер\n`;
  }
  message += `Время: ${time} (UTC+3)`;

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
      await bot.sendMessage(chatId, message);
    } catch (err) {
      console.error('Telegram send error:', err);
    }
  }

  res.status(200).json({ ok: true });
});

// ---------------- СТАРТ ----------------

app.listen(PORT, async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  try {
    await bot.setWebHook(`${DOMAIN}/bot${TELEGRAM_TOKEN}`);
    console.log('✅ Webhook установлен');
  } catch (err) {
    console.error('Ошибка установки webhook:', err);
  }
});
