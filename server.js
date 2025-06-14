const express = require('express');
const fs = require('fs');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const UAParser = require('ua-parser-js');
const cors = require('cors');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DOMAIN = process.env.DOMAIN;
const CHAT_IDS = (process.env.CHAT_IDS || '').split(',').map(id => id.trim());
const ADMINS = CHAT_IDS.map(String);
const VISITORS_FILE = './visitors.json';

if (!TELEGRAM_TOKEN || !DOMAIN) {
  console.error('❌ TELEGRAM_TOKEN и DOMAIN обязательны!');
  process.exit(1);
}

let visitors = {};
if (fs.existsSync(VISITORS_FILE)) {
  try {
    visitors = JSON.parse(fs.readFileSync(VISITORS_FILE, 'utf8'));
  } catch (err) {
    console.error('❌ Ошибка чтения visitors.json:', err);
    visitors = {};
  }
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

const knownMobileVendors = [
  'Xiaomi', 'Redmi', 'POCO', 'Mi', 'Realme', 'Vivo', 'Oppo', 'Samsung', 'SM', 'OnePlus',
  'Pixel', 'Nokia', 'Motorola', 'Moto', 'Huawei', 'Honor', 'Asus', 'Lenovo'
];

function extractDeviceModel(ua) {
  const regex = new RegExp(`\\b((${knownMobileVendors.join('|')})[-\\s]?[\\w\\d\\s\\+]+)`, 'i');
  const match = ua.match(regex);
  if (match) return match[1].replace(/Build.*/i, '').trim();
  return null;
}

function detectBrowserType(ua) {
  const mobileIndicators = ['Mobile', 'Android', 'iPhone', 'iPad', 'iPod', 'Windows Phone'];
  const desktopIndicators = ['Windows NT', 'Macintosh', 'X11', 'Linux x86_64'];

  const isMobile = mobileIndicators.some(s => ua.includes(s));
  const isDesktop = desktopIndicators.some(s => ua.includes(s));

  if (isMobile && !isDesktop) return '📱 Мобильный';
  if (isDesktop && !isMobile) return '💻 ПК';
  if (ua.toLowerCase().includes('tablet')) return '📲 Планшет';
  return '❔ Неизвестный тип';
}

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
  return /bot|crawl|spider|headless|python|curl|wget/i.test(ua);
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

app.post(`/bot${TELEGRAM_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const userId = String(msg.from?.id);
  const text = (msg.text || '').trim().toLowerCase();
  if (!ADMINS.includes(userId)) return;

  try {
    if (text === '/start') {
      const ping = await fetch(`${DOMAIN}/ping-bot`);
      await bot.sendMessage(chatId, ping.ok ? '✅ Сайт пингуется.' : `❌ Ошибка пинга (${ping.status})`);
    } else if (text === '/stats') {
      const today = new Date().toISOString().split('T')[0];
      const todayVisits = Object.values(visitors).filter(v => v.time.startsWith(today));
      const unique = new Set(todayVisits.map(v => v.fingerprint)).size;
      await bot.sendMessage(chatId, `📊 За сегодня:\nВсего: ${todayVisits.length}\nУникальных: ${unique}`);
    } else {
      await bot.sendMessage(chatId, '❓ Команда не распознана. Используй /start или /stats');
    }
  } catch (err) {
    console.error('TG command error:', err);
    await bot.sendMessage(chatId, '❌ Ошибка выполнения команды.');
  }
});

app.get('/ping-bot', async (req, res) => {
  const ip = extractIPv4(req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  const geo = await getIPGeo(ip);
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' });

  const msg = `📡 ПИНГ-БОТ\nТип: 🤖 Бот\nIP: ${geo}\nВремя: ${time} (UTC+3)`;
  for (const chatId of CHAT_IDS) {
    try {
      await bot.sendMessage(chatId, msg);
    } catch (e) {
      console.error('Telegram send error:', e);
    }
  }
  res.status(200).send('pong');
});

app.post('/collect', async (req, res) => {
  const { fingerprint, ip, userAgent, device, os, browser } = req.body || {};

  const realIp = extractIPv4(ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  if (!fingerprint && !realIp) return res.status(400).json({ ok: false, error: 'Нет fingerprint или IP' });

  let parsedUA = null;
  try {
    parsedUA = userAgent ? new UAParser(userAgent) : null;
  } catch {}

  let vendor = parsedUA?.getDevice().vendor || '';
  let model = parsedUA?.getDevice().model || '';

  if (!model || model.toLowerCase() === 'mobile') {
    const extracted = extractDeviceModel(userAgent);
    if (extracted) {
      model = extracted;
      vendor = '';
    }
  }

  const deviceParsed = [vendor, model].filter(Boolean).join(' ') || extractDeviceModel(userAgent) || '📱 Android';
  const browserParsed = browser || parsedUA?.getBrowser().name || 'неизвестно';
  const osParsed = os || parsedUA?.getOS().name || 'неизвестно';
  const browserType = detectBrowserType(userAgent);
  const statusInfo = getVisitStatus(fingerprint, realIp);
  const isBot = detectBot(userAgent);
  const type = isBot ? '🤖 Бот' : '👤 Человек';
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' });
  const geo = await getIPGeo(realIp);

  let message = '';
  if (statusInfo.status === 'new') {
    message += '🆕 НОВЫЙ ЗАХОД\n';
  } else if (statusInfo.status === 'repeat') {
    message += `♻️ ПОВТОРНЫЙ ЗАХОД (шанс ${statusInfo.score}%)\n`;
    message += `Последний визит: ${new Date(statusInfo.lastSeen).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}\n`;
  } else {
    message += '❔ НЕИЗВЕСТНЫЙ ЗАХОД\n';
  }

  message += `Тип: ${type}\nIP: ${geo}\n`;
  message += `Устройство: ${deviceParsed}\nБраузер: ${browserParsed}, ${osParsed} (${browserType})\n`;
  message += `Время: ${time} (UTC+3)`;

  if (statusInfo.status !== 'repeat' && fingerprint) {
    visitors[fingerprint] = {
      fingerprint,
      ip: realIp,
      time: new Date().toISOString()
    };
    try {
      fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitors, null, 2));
    } catch (err) {
      console.error('❌ Ошибка записи visitors.json:', err);
    }
  }

  for (const chatId of CHAT_IDS) {
    try {
      await bot.sendMessage(chatId, message);
    } catch (e) {
      console.error('Telegram send error:', e);
    }
  }

  res.status(200).json({ ok: true });
});

app.listen(PORT, async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  try {
    await bot.setWebHook(`${DOMAIN}/bot${TELEGRAM_TOKEN}`);
    console.log('✅ Webhook Telegram установлен');
  } catch (err) {
    console.error('❌ Ошибка установки Webhook:', err);
  }
});
