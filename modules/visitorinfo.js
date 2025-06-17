const axios = require('axios');
const net = require('net');
const parsdevice = require('./parsdevice');

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
    const device = parsdevice(headers['user-agent']);

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

module.exports = {
    analyzeVisitor,
    extractIPv4
};
