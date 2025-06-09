const express = require('express');
const fs = require('fs');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const UAParser = require('ua-parser-js');

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DOMAIN = process.env.DOMAIN;
if (!TELEGRAM_TOKEN || !DOMAIN) {
  console.error('TELEGRAM_TOKEN и DOMAIN должны быть заданы в переменных окружения!');
  process.exit(1);
}
const CHAT_IDS = (process.env.CHAT_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);
const ADMINS = CHAT_IDS.map(id => parseInt(id)).filter(Boolean);
const VISITORS_FILE = './visitors.json';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

app.use(bodyParser.json());
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

bot.on('message', (msg) => {
  const text = msg.text?.toLowerCase().trim();
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!ADMINS.includes(userId)) return;

  if (text === '/start') {
    bot.sendMessage(chatId, '✅ Сайт работает и бот на связи');
  }

  if (text === 'стата') {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // формат YYYY-MM-DD
    const visitsToday = Object.values(visitors).filter(v => v.time?.startsWith(dateStr));

    const total = visitsToday.length;
    const bots = visitsToday.filter(v => v.type === 'bot').length;
    const humans = total - bots;

    // Группировка по часу
    const hourlyMap = {};
    for (const v of visitsToday) {
      const date = new Date(v.time);
      const hour = (date.getUTCHours() + 3) % 24; // UTC+3
      const slot = `${hour.toString().padStart(2, '0')}:00–${(hour + 1).toString().padStart(2, '0')}:00`;
      hourlyMap[slot] = (hourlyMap[slot] || 0) + 1;
    }

    const hourlyText = Object.entries(hourlyMap)
      .sort()
      .map(([slot, count]) => `- ${slot} → ${count}`)
      .join('\n');

    const response = `📊 Статистика за сегодня (${dateStr.split('-').reverse().join('.')}):
Всего визитов: ${total}
👤 Люди: ${humans}
🤖 Боты: ${bots}

Поток за сегодня:
${hourlyText || 'Нет данных.'}`;

    bot.sendMessage(chatId, response);
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

app.get('/ping-bot', async (req, res) => {
  const userAgent = req.headers['user-agent'] || '';
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' (UTC+3)';

  let geo = 'Неизвестно';
  try {
    const geoData = await fetch(`http://ip-api.com/json/${ip}`).then(res => res.json());
    if (geoData?.status === 'success') {
      geo = `${geoData.query} — ${geoData.country}, ${geoData.city}`;
    }
  } catch (err) {
    console.error('Geo error:', err);
  }

  const message = `📡 ПИНГ БОТ\nТип: 🤖 Пинг бот\nIP: ${geo}\nВремя: ${time}`;

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

  res.status(200).send('pong');
});

app.post('/collect', async (req, res) => {
  const { fingerprint, ip, userAgent, device, os, browser } = req.body || {};
  const realIp = ip || (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();

  if (!fingerprint && !realIp) {
    return res.status(400).json({ ok: false, error: 'Не указан fingerprint или ip' });
  }

  let parsedUA = null;
  try {
    parsedUA = userAgent ? new UAParser(userAgent) : null;
  } catch (err) {
    parsedUA = null;
  }

  const deviceParsed = device || (parsedUA?.getDevice().model || guessDeviceFromUA(userAgent));
  const browserParsed = browser || (parsedUA?.getBrowser().name || 'неизвестно');
  const osParsed = os || (parsedUA?.getOS().name || '');

  const statusInfo = getVisitStatus(fingerprint, realIp);
  const isBot = detectBot(userAgent);
  const type = isBot ? '🤖 Бот' : '👤 Человек';
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' (UTC+3)';

  let geo = 'Неизвестно';
  try {
    const geoData = await fetch(`http://ip-api.com/json/${realIp}`).then(res => res.json());
    if (geoData?.status === 'success') {
      geo = `${geoData.query} — ${geoData.country}, ${geoData.city}`;
    }
  } catch (err) {
    console.error('Geo error:', err);
  }

  let message = '';
  if (statusInfo.status === 'new') {
    message += '🆕 НОВЫЙ ЗАХОД\n';
  } else if (statusInfo.status === 'repeat') {
    message += `♻️ ПОВТОРНЫЙ ЗАХОД (шанс ${statusInfo.score}%)\n`;
    message += `Последний визит: ${new Date(statusInfo.lastSeen).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (UTC+3)\n`;
  } else {
    message += '❔ НЕИЗВЕСТНЫЙ ЗАХОД\n';
  }

  message += `Тип: ${type}\n`;
  message += `IP: ${geo}\n`;
  message += `Устройство: ${deviceParsed}\n`;
  message += `Браузер: ${browserParsed}, ${osParsed}\n`;
  message += `Время: ${time}`;

  if (statusInfo.status !== 'repeat' && fingerprint) {
    visitors[fingerprint] = {
      fingerprint,
      ip: realIp,
      time: new Date().toISOString(),
      type: isBot ? 'bot' : 'human'
    };
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
    console.error('Ошибка установки webhook:', err);
  }
});

// 🔁 Self-ping каждые 4 минуты
setInterval(() => {
  fetch(`${DOMAIN}/ping-bot`)
    .then(() => console.log('🔁 Self-ping выполнен'))
    .catch(err => console.error('Self-ping error:', err));
}, 240_000); // 4 мин = 240000 мс

    console.error('Ошибка установки webhook:', err);
  }
});
