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

    // Получаем IP и геолокацию
    const ipData = await fetch('https://ipapi.co/json/').then(r => r.json());

    // Собираем данные
    const payload = {
      fingerprint,
      ip: ipData.ip || null,
      country: ipData.country_name || null,
      city: ipData.city || null,
      userAgent: navigator.userAgent,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      touchSupport: 'ontouchstart' in window,
      plugins: Array.from(navigator.plugins).map(p => p.name),
    };

    // Отправляем на сервер
    await fetch('/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('Ошибка в анализаторе:', err);
  }
})();
