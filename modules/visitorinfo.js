const axios = require('axios');
const net = require('net');

// IP check services (fallback chain)
const ipServices = [
    async ip => {
        // ip-api.com
        try {
            const { data } = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,query,isp,org,as,reverse,proxy,mobile,hosting`);
            if (data.status === 'success') return data;
        } catch {}
        return null;
    },
    async ip => {
        // ipinfo.io
        try {
            const { data } = await axios.get(`https://ipinfo.io/${ip}/json`);
            if (data && data.ip) return data;
        } catch {}
        return null;
    },
    async ip => {
        // ipgeolocation.io
        try {
            const { data } = await axios.get(`https://api.ipgeolocation.io/ipgeo?apiKey=YOUR_API_KEY&ip=${ip}`);
            if (data && data.ip) return data;
        } catch {}
        return null;
    }
];

// Convert IPv6 to IPv4 if possible
function ipv6to4(ip) {
    if (net.isIPv6(ip)) {
        // IPv4-mapped IPv6: ::ffff:192.0.2.128
        const match = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
        if (match) return match[1];
        // Other IPv6: not convertible, return as is
    }
    return ip;
}

// Извлечение IPv4 из строки (x-forwarded-for, ::ffff:...)
function extractIPv4(rawIp) {
    if (!rawIp) return '';
    const ip = rawIp.split(',')[0].trim();
    const match = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
    if (match) return match[1];
    return ip;
}

// Simple bot detection
function isBot(ua) {
    if (!ua) return false;
    const bots = [
        /googlebot/i, /bingbot/i, /yandexbot/i, /duckduckbot/i, /baiduspider/i,
        /slurp/i, /sogou/i, /exabot/i, /facebot/i, /ia_archiver/i,
        /bot/i, /spider/i, /crawler/i
    ];
    return bots.some(rx => rx.test(ua));
}

// Tor/VPN/Proxy detection (heuristics)
function analyzeSuspicious({ ipInfo, headers }) {
    let score = 0;
    // Proxy/VPN flag from IP service
    if (ipInfo.proxy || ipInfo.hosting) score += 40;
    // Suspicious ISP/org
    if (ipInfo.org && /(vpn|proxy|tor|hosting|cloud|digitalocean|ovh|amazon|google)/i.test(ipInfo.org)) score += 20;
    // Language mismatch
    if (headers['accept-language'] && ipInfo.country) {
        const lang = headers['accept-language'].split(',')[0].toLowerCase();
        if (!lang.includes(ipInfo.country.toLowerCase())) score += 10;
    }
    // Timezone mismatch (if available)
    if (headers['timezone'] && ipInfo.timezone) {
        if (headers['timezone'] !== ipInfo.timezone) score += 10;
    }
    // User-Agent country/language mismatch (new)
    if (headers['user-agent'] && ipInfo.country) {
        const ua = headers['user-agent'].toLowerCase();
        if (!ua.includes(ipInfo.country.toLowerCase()) && !ua.includes(ipInfo.city ? ipInfo.city.toLowerCase() : '')) score += 5;
    }
    // User-Agent and Accept-Language mismatch (new)
    if (headers['user-agent'] && headers['accept-language']) {
        const ua = headers['user-agent'].toLowerCase();
        const lang = headers['accept-language'].split(',')[0].toLowerCase();
        if (!ua.includes(lang)) score += 5;
    }
    // Mobile flag
    if (ipInfo.mobile) score += 5;
    // User-Agent anomalies
    if (headers['user-agent'] && /torbrowser|vpn|proxy/i.test(headers['user-agent'])) score += 10;
    // Clamp score
    if (score > 100) score = 100;
    if (score < 1) score = 1;
    return score;
}

// Main function: analyze visitor
async function analyzeVisitor({ ip, headers }) {
    ip = ipv6to4(ip);

    // Bot check
    if (isBot(headers['user-agent'])) return null; // Ignore bots

    // IP info with fallback
    let ipInfo = null;
    for (const svc of ipServices) {
        ipInfo = await svc(ip);
        if (ipInfo) break;
    }
    if (!ipInfo) ipInfo = { ip };

    // Device info
    const device = parseDevice(headers['user-agent']);

    // Suspicious score
    const suspicious = analyzeSuspicious({ ipInfo, headers });

    // Confidence: сейчас максимум 100% (если все признаки совпали)
    // Обычно для обычного пользователя будет 1-30%, для подозрительных 40-100%
    const confidence = 100 - suspicious; // Чем выше suspicious, тем ниже доверие

    // Device characteristics (best effort, no extra requests)
    const deviceDetails = {};
    if (headers['user-agent']) {
        // Example: screen size, platform, etc. (if sent by client)
        if (headers['x-device-width']) deviceDetails.width = headers['x-device-width'];
        if (headers['x-device-height']) deviceDetails.height = headers['x-device-height'];
        if (headers['x-platform']) deviceDetails.platform = headers['x-platform'];
    }

    // Compose result (for server.js: IP: 123.123.123.123, Россия, Москва)
    let geoStr = '';
    if (ipInfo.country && ipInfo.city) geoStr = `${ipInfo.country}, ${ipInfo.city}`;
    else if (ipInfo.country) geoStr = ipInfo.country;

    // Получаем координаты, если есть
    const lat = ipInfo.lat || (ipInfo.loc ? ipInfo.loc.split(',')[0] : undefined);
    const lon = ipInfo.lon || (ipInfo.loc ? ipInfo.loc.split(',')[1] : undefined);

    // Формируем ссылку на карту, если координаты валидны и ip не "неизвестно"
    let mapUrl = null;
    if (lat && lon && ipInfo.ip && ipInfo.ip !== 'неизвестно') {
        mapUrl = `https://www.google.com/maps?q=${lat},${lon}`;
    }

    return {
        ip: ipInfo.ip || ip,
        geoStr,
        suspicious, // 1-100 (чем выше, тем подозрительнее)
        confidence, // 1-100 (чем выше, тем больше доверие)
        device,
        deviceDetails,
        lat,
        lon,
        mapUrl // ссылка для инлайн-кнопки
    };
}

// Получение геоданных по IP (асинхронно)
async function getGeo(ip) {
    ip = ipv6to4(ip);
    let ipInfo = null;
    for (const svc of ipServices) {
        ipInfo = await svc(ip);
        if (ipInfo) break;
    }
    if (!ipInfo) ipInfo = { ip };
    let location = '';
    if (ipInfo.country && ipInfo.city) location = `${ipInfo.country}, ${ipInfo.city}`;
    else if (ipInfo.country) location = ipInfo.country;
    return {
        ...ipInfo,
        location,
        lat: ipInfo.lat || (ipInfo.loc ? ipInfo.loc.split(',')[0] : undefined),
        lon: ipInfo.lon || (ipInfo.loc ? ipInfo.loc.split(',')[1] : undefined),
        org: ipInfo.org,
        proxy: ipInfo.proxy,
        hosting: ipInfo.hosting,
        cached: false // если нужно, можно добавить кэширование
    };
}

// Проверка, является ли IP GoogleBot'ом (или другим крупным ботом)
function isGoogleIP(ip) {
    // Проверка по основным диапазонам Google (можно расширять при необходимости)
    // Googlebot: 66.249.0.0/16, 64.233.160.0/19, 72.14.192.0/18, 203.208.32.0/19, 74.125.0.0/16, 216.239.32.0/19, 209.85.128.0/17, 66.102.0.0/20, 64.18.0.0/20, 108.177.8.0/21, 35.191.0.0/16, 130.211.0.0/22
    const googleRanges = [
        /^66\.249\./,
        /^64\.233\./,
        /^72\.14\./,
        /^203\.208\./,
        /^74\.125\./,
        /^216\.239\./,
        /^209\.85\./,
        /^66\.102\./,
        /^64\.18\./,
        /^108\.177\./,
        /^35\.191\./,
        /^130\.211\./
    ];
    return googleRanges.some(rx => rx.test(ip));
}

// Определение статуса визита (новый, повторный, неизвестный)
function getVisitStatus(visitors, fingerprint, ip) {
    // Если нет fingerprint и ip — неизвестно
    if (!fingerprint && !ip) return { status: 'unknown', reason: 'Нет fingerprint и IP' };
    // Если fingerprint есть в базе — повторный
    if (fingerprint && visitors[fingerprint]) {
        return {
            status: 'repeat',
            score: 100,
            reason: 'Fingerprint совпал',
            lastSeen: visitors[fingerprint].time
        };
    }
    // Если ip есть в базе — повторный (но менее надёжно)
    const ipKey = `ip_${ip}`;
    if (ip && visitors[ipKey]) {
        return {
            status: 'repeat',
            score: 70,
            reason: 'IP совпал',
            lastSeen: visitors[ipKey].time
        };
    }
    // Новый визит
    return { status: 'new', reason: 'Новый fingerprint или IP' };
}

// Определение ОС и браузера по user-agent (минималистично)
function parseDevice(userAgent) {
  if (!userAgent) return { device: "неизвестный", browser: "неизвестно", os: "неизвестна", reason: "User-Agent пустой" };

  // Определение браузера
  let browser = "неизвестно";
  if (/YaBrowser/i.test(userAgent)) browser = "Yandex";
  else if (/OPR\//i.test(userAgent)) browser = "Opera";
  else if (/Opera/i.test(userAgent)) browser = "Opera";
  else if (/Edg\//i.test(userAgent)) browser = "Edge";
  else if (/Brave/i.test(userAgent)) browser = "Brave";
  else if (/Chrome/i.test(userAgent)) browser = "Chrome";
  else if (/Firefox/i.test(userAgent)) browser = "Firefox";
  else if (/Safari/i.test(userAgent)) browser = "Safari";
  else if (/MSIE|Trident/i.test(userAgent)) browser = "Internet Explorer";
  else if (/OPGX/i.test(userAgent)) browser = "Opera GX";

  // Определение ОС
  let os = "неизвестна";
  if (/Windows NT/i.test(userAgent)) os = "Windows";
  else if (/Mac OS X/i.test(userAgent)) os = "macOS";
  else if (/Android/i.test(userAgent)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(userAgent)) os = "iOS";
  else if (/Linux/i.test(userAgent)) os = "Linux";

  return { device: os, browser, os };
}

module.exports = {
    analyzeVisitor,
    extractIPv4,
    isGoogleIP,
    getGeo,
    getVisitStatus,
    parseDevice
};
