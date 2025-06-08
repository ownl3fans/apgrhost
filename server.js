const express = require('express');
const fs = require('fs');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DOMAIN = process.env.DOMAIN;
const CHAT_IDS = (process.env.CHAT_IDS || '').split(',').map(id => id.trim());
const ADMINS = CHAT_IDS.map(id => parseInt(id));
const VISITORS_FILE = './visitors.json';

const bot = new TelegramBot(TELEGRAM_TOKEN);

app.use(bodyParser.json());
app.use(express.static('public'));

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

let visitors = {};
if (fs.existsSync(VISITORS_FILE)) {
  visitors = JSON.parse(fs.readFileSync(VISITORS_FILE));
}

bot.on('message', (msg) => {
  const text = msg.text?.toLowerCase().trim();
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!ADMINS.includes(userId)) return;

  if (text === 'стата') {
    const total = Object.keys(visitors).length;
    const unique = new Set(Object.values(visitors).map(v => v.fingerprint)).size;
    bot.sendMessage(chatId, `📊 Статистика:\nВсего визитов: ${total}\nУникальных: ${unique}`);
  }

  if (text === 'ласт') {
    const last = Object.values(visitors).slice(-1)[0];
    if (!last) return bot.sendMessage(chatId, 'Нет визитов.');
    const msgText = `🕒 Последний визит:\nFingerprint: ${last.fingerprint}\nIP: ${last.ip}\nВремя: ${new Date(last.time).toLocaleString('ru-RU')}`;
    bot.sendMessage(chatId, msgText);
  }
});

function getVisitStatus(fp, ip) {
  if (!fp && !ip) return 'unknown';
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

app.post('/collect', async (req, res) => {
  const { fingerprint, ip, userAgent, device, os, browser, tz } = req.body;

  const statusInfo = getVisitStatus(fingerprint, ip);
  const isBot = detectBot(userAgent);
  const type = isBot ? '🤖 Бот' : '👤 Человек';
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: tz || 'UTC' });

  let geo = 'Неизвестно';
  try {
    const geoData = await fetch(`http://ip-api.com/json/${ip}`).then(res => res.json());
    if (geoData?.status === 'success') {
      geo = `${geoData.query} — ${geoData.country}, ${geoData.city}`;
    }
  } catch (err) {
    geo = 'Ошибка определения гео';
    console.error('Geo error:', err);
  }

  let message = '';
  if (statusInfo.status === 'new') {
    message += `🆕 НОВЫЙ ЗАХОД\n`;
  } else if (statusInfo.status === 'repeat') {
    message += `♻️ ПОВТОРНЫЙ ЗАХОД (шанс ${statusInfo.score}%)\n`;
    message += `Последний визит: ${new Date(statusInfo.lastSeen).toLocaleString('ru-RU')}\n`;
  } else {
    message += `❔ НЕИЗВЕСТНЫЙ ЗАХОД\n`;
  }

  message += `Тип: ${type}\n`;
  message += `IP: ${geo}\n`;
  message += `Устройство: ${device || 'неизвестно'}\n`;
  message += `Браузер: ${browser || 'неизвестно'}, ${os || ''}\n`;
  message += `Время: ${time} (${tz || 'UTC'})`;

  if (statusInfo.status !== 'repeat' && fingerprint) {
    visitors[fingerprint] = { fingerprint, ip, time: Date.now() };
    fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitors, null, 2));
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
    console.error('Ошибка установки webhook:', err);
  }
});
