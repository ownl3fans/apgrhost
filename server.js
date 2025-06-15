const express = require('express');
const fs = require('fs');
const fetch = require('node-fetch');
const TelegramBot = require('node-telegram-bot-api');
const UAParser = require('ua-parser-js');
const { DateTime } = require('luxon');
const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = process.env.CHAT_IDS?.split(',') || [];
const DOMAIN = process.env.DOMAIN || 'unknown-domain';
const bot = new TelegramBot(TOKEN);
const uaCache = new Map();

const visitorsFile = './visitors.json';
if (!fs.existsSync(visitorsFile)) fs.writeFileSync(visitorsFile, '[]');

const readVisitors = () => JSON.parse(fs.readFileSync(visitorsFile));
const writeVisitors = (data) => fs.writeFileSync(visitorsFile, JSON.stringify(data, null, 2));

const isBot = (ua) => {
  const botPatterns = [/bot/i, /crawler/i, /spider/i, /crawling/i, /preview/i, /Googlebot/i];
  return botPatterns.some((pattern) => pattern.test(ua));
};

async function getBrowserDataFromAPI(userAgent) {
  if (!userAgent) return { browser: 'не определён', os: 'не определена', device: 'не определено', reason: 'Пустой User-Agent' };
  if (uaCache.has(userAgent)) return { ...uaCache.get(userAgent), cached: true };

  const apiKey = 'faab5f7aef335ee5e5e82e6d6f9e077a';
  let parsed = {};
  try {
    const res = await fetch('https://api.whatismybrowser.com/api/v3/detect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify({ user_agent: userAgent })
    });

    const json = await res.json();
    const r = json?.result?.parsed;
    const browser = r?.browser_name || r?.software_sub_type;
    const os = r?.operating_system_name || r?.operating_platform;
    const device = r?.hardware_model || r?.hardware_type || r?.simple_sub_description;

    if (browser && os && device) {
      parsed = { browser, os, device };
    } else {
      throw new Error('API incomplete');
    }
  } catch {
    const parser = new UAParser(userAgent);
    const browser = parser.getBrowser().name || 'не определён';
    const os = parser.getOS().name || 'не определена';
    let device = parser.getDevice().model || parser.getDevice().vendor || parser.getDevice().type;

    if (!device) {
      device = /android|ios/i.test(os) ? 'Мобильное устройство' :
               /windows|mac|linux/i.test(os) ? 'ПК' : 'не определено';
    }

    parsed = {
      browser,
      os,
      device,
      reason: 'Fallback через UAParser.js',
    };
  }

  uaCache.set(userAgent, parsed);
  return parsed;
}

function getLocationFromIPData(data) {
  if (!data || data.status === 'fail') return { country: 'не определена', city: 'не определён' };
  return {
    country: data.country || data.country_name || 'не определена',
    city: data.city || 'не определён'
  };
}

async function getIPInfo(ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city`);
    const data = await res.json();
    if (data.status === 'success') return data;
    throw new Error('Primary IP API failed');
  } catch {
    const res = await fetch(`https://ipwhois.app/json/${ip}`);
    return await res.json();
  }
}

function findMatch(prev, fingerprint, ip) {
  const matches = prev.filter(v =>
    (fingerprint && v.fingerprint === fingerprint) || v.ip === ip
  );

  if (!matches.length) return null;

  const last = matches[matches.length - 1];
  const byFP = fingerprint && last.fingerprint === fingerprint;
  const byIP = last.ip === ip;
  const chance = byFP && byIP ? 100 : byFP || byIP ? 60 : 0;

  return {
    date: last.date,
    chance,
    byFP,
    byIP
  };
}

function formatTime(dateStr) {
  return DateTime.fromISO(dateStr).setZone('Europe/Moscow').toFormat('HH:mm:ss');
}

function formatReport(type, data) {
  const lines = [];
  lines.push(type === 'repeat' ? '🔁 ПОВТОРНЫЙ ЗАХОД' :
             type === 'unknown' ? '❓ НЕИЗВЕСТНЫЙ ЗАХОД' :
             '🆕 НОВЫЙ ЗАХОД');
  lines.push(`Тип: ${data.isBot ? '🤖 Бот' : '👤 Человек'}`);
  lines.push(`IP: ${data.ip} (${data.country}, ${data.city})`);

  if (data.device) {
    lines.push(`Устройство: ${data.device}${data.deviceReason ? ` (Причина: ${data.deviceReason})` : ''}`);
  }
  if (data.browser) {
    lines.push(`Браузер: ${data.browser}${data.browserReason ? ` (Причина: ${data.browserReason})` : ''}`);
  }

  if (type === 'repeat') {
    if (data.fingerprint) {
      lines.push(`Fingerprint: ${data.fingerprint}`);
    }
    lines.push(`Шанс совпадения: ${data.chance}% (по ${data.byFP ? 'Fingerprint' : ''}${data.byFP && data.byIP ? ' + ' : ''}${data.byIP ? 'IP' : ''})`);
    lines.push(`Предыдущий визит: ${formatTime(data.prevDate)} (UTC+3)`);
  }

  lines.push(`Время: ${formatTime(data.date)} (UTC+3)`);
  return lines.join('\n');
}

app.post('/collect', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.connection.remoteAddress || req.ip;
  const userAgent = req.body.userAgent || req.headers['user-agent'] || '';
  const fingerprint = req.body.fingerprint || null;

  if (isBot(userAgent)) return res.sendStatus(204);

  const ipData = await getIPInfo(ip);
  const { country, city } = getLocationFromIPData(ipData);
  const uaData = await getBrowserDataFromAPI(userAgent);

  const all = readVisitors();
  const now = new Date().toISOString();

  const match = findMatch(all, fingerprint, ip);
  const type = match ? 'repeat' : fingerprint ? 'new' : 'unknown';

  // Только для повторных сохраняем fingerprint
  const visitor = {
    ip,
    userAgent,
    date: now,
    country,
    city
  };
  if (match && fingerprint) visitor.fingerprint = fingerprint;

  all.push(visitor);
  writeVisitors(all);

  const msgData = {
    ip,
    country,
    city,
    fingerprint: match ? fingerprint : undefined,
    date: now,
    device: uaData.device !== 'не определено' ? uaData.device : undefined,
    deviceReason: uaData.device === 'не определено' ? uaData.reason : undefined,
    browser: uaData.browser !== 'не определён' ? uaData.browser : undefined,
    browserReason: uaData.browser === 'не определён' ? uaData.reason : undefined,
    isBot: false,
    chance: match?.chance || null,
    byFP: match?.byFP || false,
    byIP: match?.byIP || false,
    prevDate: match?.date || null
  };

  const text = formatReport(type, msgData);
  for (const id of CHAT_IDS) {
    await bot.sendMessage(id, text);
  }

  res.sendStatus(200);
});

bot.setWebHook(`${DOMAIN}/bot${TOKEN}`);
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

bot.onText(/^\/start$/, (msg) => {
  bot.sendMessage(msg.chat.id, `Бот активен. Используй /stats и /last`);
});

bot.onText(/^\/stats$/, (msg) => {
  const all = readVisitors();
  bot.sendMessage(msg.chat.id, `Всего визитов: ${all.length}`);
});

bot.onText(/^\/last$/, (msg) => {
  const all = readVisitors();
  if (!all.length) return bot.sendMessage(msg.chat.id, `Нет визитов`);
  const last = all[all.length - 1];
  const text = `Последний визит:\nIP: ${last.ip}\nВремя: ${formatTime(last.date)} (UTC+3)`;
  bot.sendMessage(msg.chat.id, text);
});

app.get('/ping-bot', (_, res) => res.send('Bot is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
