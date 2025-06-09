// === АНИМАЦИЯ КАРТОЧЕК ===
const cards = document.querySelectorAll('.card');
const textData = [
  `Кодер, осинтер.\nБольшой опыт в поиске по открытым данным, анализе данных. В 2023 был фейм, но вынужден был уйти.\nРаботаю над прогами на Python, создание сайтов на HTML/CSS/JS. Второстепенно — OSINT. Знаю Java.\nСостоял в:
OSINTATTACK — 2022г
KNZ — 2023г
309sq —2023г`,
  `Троль, снос.\nМногократное участие в конференциях, войсчатах, бифах на фейм. Огромный словарный запас, быстрый тайпинг, выдержка, позволяющая побеждать в битвах. В КМ тг с 2022 года, в КМ ds с 2017 года.\nСостоял в:
OSINTATTACK — 2022г
KNZ — 2023г
309sq —2023г`
];

cards.forEach((card, index) => {
  const typingEl = document.createElement('div');
  typingEl.classList.add('typing');
  card.appendChild(typingEl);

  let isTyping = false;
  let textVisible = false;

  card.addEventListener('click', async () => {
    if (isTyping) return;
    isTyping = true;

    if (!textVisible) {
      card.classList.add('clicked');
      typingEl.textContent = '';
      typingEl.classList.remove('typing-out');
      typingEl.classList.add('typing-in');

      await typeText(typingEl, textData[index]);

      textVisible = true;
    } else {
      typingEl.classList.remove('typing-in');
      typingEl.classList.add('typing-out');

      setTimeout(() => {
        typingEl.textContent = '';
        card.classList.remove('clicked');
        typingEl.classList.remove('typing-out');
        textVisible = false;
        isTyping = false;
      }, 500);
      return;
    }

    isTyping = false;
  });
});

function typeText(el, text) {
  return new Promise(resolve => {
    let i = 0;
    const speed = 20;
    function type() {
      if (i < text.length) {
        el.textContent += text.charAt(i);
        i++;
        setTimeout(type, speed);
      } else {
        resolve();
      }
    }
    type();
  });
}

// === АНАЛИЗАТОР ПОСЕТИТЕЛЯ ===
(async () => {
  try {
    const fp = await import('https://openfpcdn.io/fingerprintjs/v3').then(FingerprintJS => FingerprintJS.load());
    const result = await fp.get();
    const fingerprint = result.visitorId;

    const ua = navigator.userAgent;
    const language = navigator.language;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const touchSupport = 'ontouchstart' in window;
    const platform = navigator.platform;
    const deviceMemory = navigator.deviceMemory || null;
    const hardwareConcurrency = navigator.hardwareConcurrency || null;
    const screenSize = `${screen.width}x${screen.height}`;

    let ipData = {};
    try {
      ipData = await fetch('https://ipapi.co/json/').then(r => r.json());
    } catch (e1) {
      try {
        const fallback = await fetch('https://ipwhois.app/json/').then(r => r.json());
        ipData = {
          ip: fallback.ip,
          country_name: fallback.country,
          city: fallback.city
        };
      } catch (e2) {
        ipData = { ip: null, country_name: null, city: null };
      }
    }

    const browser = (() => {
      if (ua.includes('Edg')) return 'Edge';
      if (ua.includes('OPR') || ua.includes('Opera')) return 'Opera';
      if (ua.includes('Chrome')) return 'Chrome';
      if (ua.includes('Firefox')) return 'Firefox';
      if (ua.includes('Safari')) return 'Safari';
      return 'Неизвестен';
    })();

    const os = (() => {
      if (/Windows NT/.test(ua)) return 'Windows';
      if (/Mac OS X/.test(ua)) return 'macOS';
      if (/Android/.test(ua)) return 'Android';
      if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
      if (/Linux/.test(ua)) return 'Linux';
      return 'Неизвестна';
    })();

    const deviceType = /Mobi|Android/i.test(ua) ? 'Мобильное' : 'ПК';

    const payload = {
      fingerprint,
      ip: ipData.ip,
      country: ipData.country_name,
      city: ipData.city,
      userAgent: ua,
      language,
      timezone,
      platform,
      touchSupport,
      deviceMemory,
      hardwareConcurrency,
      browser,
      os,
      deviceType,
      screenSize
    };

    await fetch('/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  } catch (err) {
    console.warn('Ошибка в анализаторе:', err);
  }
})();
