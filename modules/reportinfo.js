function buildShortReport({ status, fp, userAgent, timezone, type, ip, geoStr, uaData }) {
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
  return shortMsg;
}

function buildDetailsReport({ geoData, userAgent, fp, webrtcIps, ip, screenSize, width, height, platform }) {
  let detailsMsg = '';
  detailsMsg += `Провайдер: ${geoData?.org || 'неизвестно'}\n`;
  detailsMsg += `VPN/Proxy/Tor: ${(geoData?.proxy || geoData?.hosting) ? 'Да' : 'Нет'}\n`;
  detailsMsg += `User-Agent: ${userAgent || 'неизвестно'}\n`;
  detailsMsg += `Fingerprint: ${fp || 'неизвестно'}\n`;
  if (Array.isArray(webrtcIps) && webrtcIps.length) {
    let webrtcNote = '';
    if (ip && webrtcIps.some(wip => wip !== ip)) {
      webrtcNote = ' (отличаются от внешнего IP)';
    }
    detailsMsg += `WebRTC IPs: ${webrtcIps.join(', ')}${webrtcNote}\n`;
  } else {
    detailsMsg += 'WebRTC IPs: нет данных\n';
  }
  if (screenSize) {
    detailsMsg += `Размер экрана: ${screenSize}\n`;
  } else if (width && height) {
    detailsMsg += `Размер экрана: ${width}x${height}\n`;
  } else {
    detailsMsg += 'Размер экрана: неизвестно\n';
  }
  if (width || height || platform) {
    detailsMsg += 'Доп. device info: ';
    if (width) detailsMsg += `width: ${width} `;
    if (height) detailsMsg += `height: ${height} `;
    if (platform) detailsMsg += `platform: ${platform}`;
    detailsMsg += '\n';
  }
  return detailsMsg;
}

function buildInlineKeyboard(visitId) {
  return [[{ text: 'Детали', callback_data: `details_${visitId}` }]];
}

async function sendLocationWithReport(bot, chatId, geoData, shortMsg, inlineKeyboard) {
  await bot.sendLocation(chatId, geoData.lat, geoData.lon, {
    caption: shortMsg
  });
  await bot.sendMessage(chatId, '👇', {
    reply_markup: { inline_keyboard: inlineKeyboard }
  });
}

async function sendShortReport(bot, chatId, shortMsg, inlineKeyboard) {
  await bot.sendMessage(chatId, shortMsg, {
    reply_markup: { inline_keyboard: inlineKeyboard }
  });
}

function formatDate(date, tz) {
  try {
    return new Date(date).toLocaleString('ru-RU', { timeZone: tz || 'UTC' });
  } catch {
    return date;
  }
}

module.exports = {
  buildShortReport,
  buildDetailsReport,
  buildInlineKeyboard,
  sendLocationWithReport,
  sendShortReport
};
