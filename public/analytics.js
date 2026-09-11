/* ============================================================
   AskHub · Аналитика: Яндекс.Метрика + Google Analytics 4
   Единый файл — подключается во все страницы.
   ID подставляются после создания счётчиков (см. README).
   ============================================================ */
(function () {
  // === НАСТРОЙКА: замените значения после регистрации счётчиков ===
  var YM_ID = window.ASKHUB_YM_ID || 112491194;         // Яндекс.Метрика AskHub
  var GA_ID = window.ASKHUB_GA_ID || 'G-DYJFJLCW9B';    // GA4 AskHub
  // ================================================================

  // --- GDPR: проверяем согласие в ЕС ---
  var consent = null;
  try { consent = localStorage.getItem('askhub_analytics_consent'); } catch (_) {}

  // Простая эвристика: если язык браузера ru/sr — считаем не-ЕС (Метрика можно сразу),
  // GA грузим после клика Accept на банере.
  var lang = (navigator.language || '').toLowerCase();
  var isProbablyEU = !(lang.startsWith('ru') || lang.startsWith('sr'));

  // --- Яндекс.Метрика (безопасно вне ЕС) ---
  if (YM_ID) {
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      for (var j = 0; j < document.scripts.length; j++) {
        if (document.scripts[j].src === r) return;
      }
      k = e.createElement(t); a = e.getElementsByTagName(t)[0];
      k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
    window.ym(YM_ID, 'init', {
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
      webvisor: true,
      ecommerce: 'dataLayer'
    });
  }

  // --- Google Analytics 4 ---
  function loadGA() {
    if (!GA_ID || window.__askhub_ga_loaded) return;
    window.__askhub_ga_loaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, { anonymize_ip: true });
  }

  if (GA_ID) {
    if (!isProbablyEU || consent === 'yes') {
      loadGA();
    } else if (consent !== 'no') {
      // Показываем ненавязчивый банер
      document.addEventListener('DOMContentLoaded', function () {
        if (document.getElementById('askhub-cookie-banner')) return;
        var texts = {
          ru: { msg: 'Мы используем cookie для аналитики. Продолжая, вы соглашаетесь.', ok: 'Принять', no: 'Отклонить' },
          en: { msg: 'We use cookies for analytics. By continuing you agree.', ok: 'Accept', no: 'Decline' },
          sr: { msg: 'Koristimo kolačiće za analitiku. Nastavkom se slažete.', ok: 'Prihvati', no: 'Odbij' }
        };
        var lg = (document.documentElement.lang || 'ru').slice(0, 2).toLowerCase();
        var t = texts[lg] || texts.ru;
        var wrap = document.createElement('div');
        wrap.id = 'askhub-cookie-banner';
        wrap.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(60px + env(safe-area-inset-top));z-index:99999;background:#12121a;color:#e6e6f0;border:1px solid #2a2a38;border-radius:10px;padding:8px 10px;display:flex;gap:8px;align-items:center;font:12.5px/1.35 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.4);max-width:640px;margin:0 auto';
        wrap.innerHTML = '<span style="flex:1">' + t.msg + '</span>' +
          '<button id="ck-ok" style="background:linear-gradient(135deg,#a78bfa,#22d3ee);border:0;color:#0a0a0f;padding:6px 12px;border-radius:6px;font-weight:700;cursor:pointer">' + t.ok + '</button>' +
          '<button id="ck-no" style="background:transparent;border:1px solid #2a2a38;color:#c4b5ff;padding:6px 10px;border-radius:6px;cursor:pointer">' + t.no + '</button>';
        document.body.appendChild(wrap);
        document.getElementById('ck-ok').onclick = function () {
          try { localStorage.setItem('askhub_analytics_consent', 'yes'); } catch (_) {}
          wrap.remove();
          loadGA();
        };
        document.getElementById('ck-no').onclick = function () {
          try { localStorage.setItem('askhub_analytics_consent', 'no'); } catch (_) {}
          wrap.remove();
        };
      });
    }
  }
})();
