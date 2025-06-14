// === АНИМАЦИЯ КАРТОЧЕК ===
const cards = document.querySelectorAll('.card');
const descriptions = [
  `Кодер, осинтер.\nБольшой опыт в поиске по открытым данным, анализе данных. В 2023 был фейм, но вынужден был уйти.\nРаботаю над прогами на Python, создание сайтов на HTML/CSS/JS. Второстепенно — OSINT. Знаю Java.\nСостоял в:\nOSINTATTACK — 2022г\nKNZ — 2023г\n309sq — 2023г`,
  `Троль, снос.\nМногократное участие в конференциях, войсчатах, бифах на фейм. Огромный словарный запас, быстрый тайпинг, выдержка, позволяющая побеждать в битвах.\nВ КМ тг с 2022 года, в КМ ds с 2017 года.\nСостоял в:\nOSINTATTACK — 2022г\nKNZ — 2023г\n309sq — 2023г`
];

cards.forEach((card, index) => {
  const typingContainer = document.createElement('div');
  typingContainer.classList.add('typing');
  card.appendChild(typingContainer);

  let isTyping = false;
  let visible = false;

  card.addEventListener('click', async () => {
    if (isTyping) return;
    isTyping = true;

    if (!visible) {
      card.classList.add('clicked');
      typingContainer.textContent = '';
      typingContainer.classList.replace('typing-out', 'typing-in');
      await typeEffect(typingContainer, descriptions[index]);
      visible = true;
    } else {
      typingContainer.classList.replace('typing-in', 'typing-out');
      setTimeout(() => {
        typingContainer.textContent = '';
        card.classList.remove('clicked');
        typingContainer.classList.remove('typing-out');
        visible = false;
        isTyping = false;
      }, 500);
      return;
    }

    isTyping = false;
  });
});

function typeEffect(element, text, speed = 20) {
  return new Promise(resolve => {
    let i = 0;
    (function typer() {
      if (i < text.length) {
        element.textContent += text[i++];
        setTimeout(typer, speed);
      } else resolve();
    })();
  });
}

// === АНАЛИЗАТОР ПОСЕТИТЕЛЯ ===
(async () => {
  try {
    const FingerprintJS = await import('https://openfpcdn.io/fingerprintjs/v3');
    const fp = await FingerprintJS.load();
    const { visitorId: fingerprint } = await fp.get();

    const {
      userAgent,
      language,
      platform,
      deviceMemory = null,
      hardwareConcurrency = null
    } = navigator;

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const touchSupport = 'ontouchstart' in window;
    const screenSize = `${screen.width}x${screen.height}`;

    let ipData = {};
    try {
      ipData = await fetch('https://ipapi.co/json/').then(res => res.json());
    } catch {
      try {
        const fallback = await fetch('https://ipwhois.app/json/').then(res => res.json());
        ipData = {
          ip: fallback.ip,
          country_name: fallback.country,
          city: fallback.city
        };
      } catch {
        ipData = { ip: null, country_name: null, city: null };
      }
    }

    if (ipData.ip) {
      document.cookie = `ip=${ipData.ip}; path=/; max-age=1800`;
    }

    const browser = (() => {
      if (/EdgA|EdgiOS|Edg\//.test(userAgent)) return 'Edge';
      if (/SamsungBrowser/.test(userAgent)) return 'Samsung Internet';
      if (/OPR|Opera/.test(userAgent)) return 'Opera';
      if (/UCBrowser/.test(userAgent)) return 'UC Browser';
      if (/CriOS|Chrome/.test(userAgent)) return 'Chrome';
      if (/Firefox/.test(userAgent)) return 'Firefox';
      if (/Safari/.test(userAgent)) return 'Safari';
      return 'Неизвестен';
    })();

    const os = (() => {
      if (/Windows NT/.test(userAgent)) return 'Windows';
      if (/Mac OS X/.test(userAgent)) return 'macOS';
      if (/Android/.test(userAgent)) return 'Android';
      if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
      if (/Linux/.test(userAgent)) return 'Linux';
      return 'Неизвестна';
    })();

    const getModel = () => {
      const ua = userAgent.toLowerCase();
      const match = ua.match(/\(([^)]+)\)/);
      if (!match) return null;

      const raw = match[1];

      // Бренды по ключевым словам
      const brands = [
        'xiaomi', 'redmi', 'poco',
        'realme', 'vivo', 'oppo',
        'samsung', 'huawei', 'honor',
        'nokia', 'lenovo', 'oneplus',
        'sony', 'meizu', 'zte',
        'tecno', 'infinix', 'doogee'
      ];

      const found = brands.find(b => raw.includes(b));
      if (found) {
        const model = raw.split(';').map(s => s.trim()).find(s => s.toLowerCase().includes(found));
        return model || found;
      }

      return null;
    };

    const deviceModel = getModel();
    const deviceType = /Mobi|Android|iPhone|iPad/i.test(userAgent) ? 'Мобильное' : 'ПК';

    const payload = {
      fingerprint,
      ip: ipData.ip,
      country: ipData.country_name,
      city: ipData.city,
      userAgent,
      language,
      timezone,
      platform,
      touchSupport,
      deviceMemory,
      hardwareConcurrency,
      browser,
      os,
      deviceType,
      deviceModel,
      screenSize
    };

    await fetch('/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

  } catch (err) {
    console.warn('Ошибка в анализаторе:', err);
  }
})();
