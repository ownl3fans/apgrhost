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

// === Работа с файлами ===
const VISITORS_FILE = './visitors.json';
let visitors = {};
try {
  if (fs.existsSync(VISITORS_FILE)) {
    visitors = JSON.parse(fs.readFileSync(VISITORS_FILE));
  }
} catch (e) {
  console.error('Ошибка чтения visitors.json:', e);
}

// === Telegram бот ===
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

// === Утилиты ===

function extractIPv4(ip) {
  if (!ip) return '';
  // x-forwarded-for может быть списком IP через запятую
  const parts = ip.split(',');
  const first = parts[0].trim();
  // Если IP в формате IPv6 с IPv4, например ::ffff:192.168.1.1
  return first.includes(':') && first.includes('.') ? first.split(':').pop() : first;
}

function detectBot(ua) {
  if (!ua) return true;
  return /bot|crawl|spider|google|yandex|baidu|bing|duckduck/i.test(ua);
}

const googleIpRanges = [
  /^66\.249\./, /^64\.233\./, /^72\.14\./, /^203\.208\./, /^216\.239\./
];
function isGoogleIP(ip) {
  return googleIpRanges.some(regex => regex.test(ip));
}

// === Кэш ===
const geoCache = new Map();
const uaCache = new Map();

async function getGeo(ip) {
  if (geoCache.has(ip)) return geoCache.get(ip) + ' (кэш)';
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city,query`);
    const data = await res.json();
    if (data.status === 'success') {
      const geo = `${data.country}, ${data.city}`;
      geoCache.set(ip, geo);
      return geo;
    }
  } catch {}
  try {
    const res = await fetch(`https://ipwhois.app/json/${ip}`);
    const data = await res.json();
    if (data.success !== false) {
      const geo = `${data.country}, ${data.city}`;
      geoCache.set(ip, geo);
      return geo;
    }
  } catch {}
  geoCache.set(ip, 'не определено');
  return 'не определено';
}

async function getBrowserDataFromAPI(userAgent) {
  if (!userAgent) return { browser: 'неизвестно', os: 'неизвестно', device: 'неизвестно' };
  if (uaCache.has(userAgent)) return { ...uaCache.get(userAgent), cached: true };

  const apiKey = 'faab5f7aef335ee5e582e6d6f9e077a';
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
    const parsed = {
      browser: result?.browser_name || 'неизвестно',
      os: result?.operating_system_name || 'неизвестно',
      device: result?.simple_sub_description || result?.hardware_type || result?.device_type || 'неизвестно'
    };
    uaCache.set(userAgent, parsed);
    return parsed;
  } catch (e) {
    console.error('Ошибка API WhatIsMyBrowser:', e);
    return { browser: 'неизвестно', os: 'неизвестно', device: 'неизвестно' };
  }
}

// Проверка на VPN/Proxy по параметрам
function checkVPNProxy({ ipRegion, timezone, lang, clientTime, serverTime, touchSupported, userAgentDevice }) {
  let score = 0;
  const reasons = [];

  // 1. Несовпадение часового пояса и региона IP
  if (ipRegion && timezone && !timezone.includes(ipRegion.split(',')[0])) {
    score += 4;
    reasons.push(`Часовой пояс (${timezone}) не совпадает с регионом IP (${ipRegion})`);
  }

  // 2. Разница времени больше 60 минут
  if (clientTime && serverTime && Math.abs(clientTime - serverTime) > 60 * 60 * 1000) {
    score += 3;
    reasons.push('Время клиента сильно отличается от времени сервера');
  }

  // 3. Язык не совпадает с регионом IP
  if (ipRegion && lang && !lang.toLowerCase().includes(ipRegion.split(',')[0].toLowerCase())) {
    score += 2;
    reasons.push(`Язык (${lang}) не соответствует региону IP (${ipRegion})`);
  }

  // 4. Нет поддержки touch, но устройство мобильное
  if (userAgentDevice && /mobile|phone|tablet|android|iphone/i.test(userAgentDevice) && !touchSupported) {
    score += 1;
    reasons.push('Устройство мобильное, но touch-события не поддерживаются');
  }

  return { score, reasons };
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

// === Роут для сбора визитов ===
app.post('/collect', async (req, res) => {
  const {
    fingerprint,
    userAgent,
    screenWidth,
    screenHeight,
    timezone,
    language,
    clientTime, // timestamp клиента в ms
    touchSupported,
  } = req.body || {};

  // Получаем IP клиента корректно
  const rawIp = requestIp.getClientIp(req) || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ip = extractIPv4(rawIp);

  if (!fingerprint && !ip) return res.status(400).json({ ok: false, error: 'Нет fingerprint и IP' });
  if (isGoogleIP(ip)) {
    // Пропускаем GoogleBot
    return res.status(200).json({ ok: true, skip: 'googlebot' });
  }

  // Определяем браузер/устройство через API
  const uaResult = await getBrowserDataFromAPI(userAgent);

  // Получаем гео по IP
  const geoRaw = await getGeo(ip);
  // Для упрощения региона возьмём страну из geoRaw, например "Russia, Moscow" → "Russia"
  const ipRegion = geoRaw.split(',')[0] || '';

  // Проверяем тип визита (новый/повторный)
  const status = getVisitStatus(fingerprint, ip);

  // Определяем бота по User-Agent
  const isBot = detectBot(userAgent);
  const type = isBot ? '🤖 Бот' : '👤 Человек';

  // Текущие времена
  const serverTime = Date.now();
  const clientTimeNum = clientTime ? Number(clientTime) : null;

  // Проверка VPN/Proxy
  const vpnCheck = checkVPNProxy({
    ipRegion,
    timezone,
    lang: language,
    clientTime: clientTimeNum,
    serverTime,
    touchSupported: !!touchSupported,
    userAgentDevice: uaResult.device
  });

  // Формируем сообщение
  let msg = '';

  if (status.status === 'new') {
    msg += '🆕 НОВЫЙ ЗАХОД\n';
  } else if (status.status === 'repeat') {
    msg += `♻️ ПОВТОРНЫЙ ЗАХОД\nШанс совпадения: ${status.score}% (${status.reason})\n`;
    msg += `Последний визит: ${new Date(status.lastSeen).toLocaleString('ru-RU', { timeZone: timezone || 'UTC' })}\n`;
  } else {
    msg += '❓ НЕИЗВЕСТНЫЙ ЗАХОД\n';
  }

  msg += `Тип: ${type}\n`;
  msg += `IP: ${ip} (${geoRaw})\n`;
  msg += `Устройство: ${uaResult.device || 'неизвестно'}\n`;
  msg += `ОС: ${uaResult.os || 'неизвестно'}\n`;
  msg += `Браузер: ${uaResult.browser || 'неизвестно'}\n`;
  if (!userAgent) msg += 'Причина: пустой User-Agent\n';
  if (isBot) msg += 'Причина: детектирован как бот по User-Agent\n';

  if (vpnCheck.score >= 5) {
    msg += `⚠️ Возможен VPN/Proxy (оценка ${vpnCheck.score}):\n• ${vpnCheck.reasons.join('\n• ')}\n`;
  }

  // Записываем визит
  const visitId = fingerprint || `ip_${ip}`;
  visitors[visitId] = {
    fingerprint,
    ip,
    time: new Date().toISOString(),
    userAgent,
    geo: geoRaw,
    uaParsed: uaResult,
  };

  try {
    fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitors, null, 2));
  } catch (e) {
    console.error('Ошибка записи visitors.json:', e);
  }

  // Отправляем в Telegram
  for (const chatId of CHAT_IDS) {
    try {
      await bot.sendMessage(chatId, msg);
    } catch (e) {
      console.error('Ошибка отправки сообщения в Telegram:', e);
    }
  }

  res.json({ ok: true });
});

// === Запуск сервера ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
