const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const requestIp = require('request-ip');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.set('trust proxy', true);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = (process.env.CHAT_IDS || '').split(',').map(id => id.trim());
const DOMAIN = process.env.DOMAIN || 'https://example.com';

const VISITORS_FILE = './visitors.json';
let visitors = {};
try {
  if (fs.existsSync(VISITORS_FILE)) {
    visitors = JSON.parse(fs.readFileSync(VISITORS_FILE));
  }
} catch (e) {
  console.error('Ошибка чтения visitors.json:', e);
}

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
  const keys = Object.keys(visitors);
  bot.sendMessage(msg.chat.id, `👀 Всего визитов: ${keys.length}`);
});

app.get('/ping-bot', (req, res) => res.status(200).send('OK'));

function extractIPv4(ip) {
  if (!ip) return '';
  const parts = ip.split(',');
  const first = parts[0].trim();
  return first.includes(':') ? first.split(':').pop() : first;
}

async function getGeo(ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city,query`);
    const data = await res.json();
    if (data.status === 'success') return `${data.country}, ${data.city}`;
  } catch {}
  try {
    const res = await fetch(`https://ipwhois.app/json/${ip}`);
    const data = await res.json();
    if (data.success !== false) return `${data.country}, ${data.city}`;
  } catch {}
  return 'не определено';
}

function detectBot(ua) {
  if (!ua) return true;
  return /bot|crawl|spider|google|yandex|baidu|bing|duckduck/i.test(ua);
}

function getVisitStatus(fingerprint, ip) {
  const id = fingerprint || `ip_${ip}`;
  const entry = visitors[id];
  if (!entry) return { status: 'new' };
  const now = Date.now();
  const last = new Date(entry.time).getTime();
  const diff = (now - last) / 1000;

  const sameIP = entry.ip === ip;
  const score = fingerprint ? (sameIP ? 100 : 60) : 50;
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

async function getBrowserDataFromAPI(userAgent) {
  const apiKey = 'faab5f7aef335ee5e5e82e6d6f9e077a';
  const apiUrl = 'https://api.whatismybrowser.com/api/v3/detect';

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey
      },
      body: JSON.stringify({ user_agent: userAgent })
    });

    const json = await res.json();
    const result = json?.result?.parsed;

    return {
      browser: result?.browser_name || 'неизвестно',
      os: result?.operating_system_name || 'неизвестно',
      device: result?.simple_sub_description || result?.hardware_type || result?.device_type || 'неизвестно'
    };
  } catch (e) {
    console.error('Ошибка API WhatIsMyBrowser:', e);
    return { browser: 'неизвестно', os: 'неизвестно', device: 'неизвестно' };
  }
}

app.post('/collect', async (req, res) => {
  const { fingerprint, userAgent } = req.body || {};
  const rawIp = requestIp.getClientIp(req) || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ip = extractIPv4(rawIp);

  if (!fingerprint && !ip) {
    return res.status(400).json({ ok: false, error: 'Нет fingerprint и IP' });
  }

  const { browser, os, device } = await getBrowserDataFromAPI(userAgent);
  const geo = await getGeo(ip);
  const status = getVisitStatus(fingerprint, ip);
  const isBot = detectBot(userAgent);
  const type = isBot ? '🤖 Бот' : '👤 Человек';
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' });

  let msg = '';
  if (status.status === 'new') {
    msg += '🆕 НОВЫЙ ЗАХОД\n';
  } else if (status.status === 'repeat') {
    msg += `♻️ ПОВТОРНЫЙ ЗАХОД\nШанс: ${status.score}% (${status.reason})\n`;
    msg += `Последний визит: ${new Date(status.lastSeen).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}\n`;
  } else {
    msg += `❔ НЕИЗВЕСТНЫЙ ЗАХОД\nПричина: ${status.reason || 'не определено'}\n`;
  }

  msg += `Тип: ${type}\nIP: ${geo}\n`;

  msg += device !== 'неизвестно'
    ? `Устройство: ${device}\n`
    : `Устройство: не определено (User-Agent: ${userAgent || 'пустой'})\n`;

  msg += browser !== 'неизвестно'
    ? `Браузер: ${browser}\n`
    : `Браузер: не определён (User-Agent: ${userAgent || 'пустой'})\n`;

  msg += os !== 'неизвестно'
    ? `ОС: ${os}\n`
    : `ОС: не определена (User-Agent: ${userAgent || 'пустой'})\n`;

  msg += `Fingerprint: ${fingerprint || 'нет'}\nВремя: ${time} (UTC+3)`;

  for (const id of CHAT_IDS) {
    try {
      await bot.sendMessage(id, msg);
    } catch (err) {
      console.error('Ошибка Telegram:', err);
    }
  }

  visitors[fingerprint || `ip_${ip}`] = {
    time: new Date().toISOString(),
    fingerprint,
    ip,
    userAgent,
    browser,
    os,
    device
  };

  try {
    fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitors, null, 2));
  } catch (e) {
    console.error('Ошибка записи файла:', e);
  }

  res.status(200).json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
