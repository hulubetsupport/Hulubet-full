(function () {
  'use strict';

  var style = document.createElement('style');
  style.id = 'hulu-fullscreen-guard';
  style.textContent = [
    'html, body {',
    '  box-sizing: border-box !important;',
    '  width: 100% !important;',
    '  max-width: 100vw !important;',
    '  min-height: 100dvh !important;',
    '  margin: 0 !important;',
    '  overflow-x: hidden !important;',
    '}',
    '.aviator-wrapper, #app, #game-app, .keno-wrapper, .main-content-limiter, .game-wrapper, .game-container, #game-container, .slot-shell, .roulette-app {',
    '  width: 100% !important;',
    '  max-width: 100% !important;',
    '  margin-left: 0 !important;',
    '  margin-right: 0 !important;',
    '  border-radius: 0 !important;',
    '  border-left: none !important;',
    '  border-right: none !important;',
    '}',
    'body.tg-game-fullscreen {',
    '  padding-top: var(--tg-safe-top, 0px) !important;',
    '  padding-bottom: var(--tg-safe-bottom, 0px) !important;',
    '}',
    'body.tg-game-fullscreen #game-app,',
    'body.tg-game-fullscreen #game-container,',
    'body.tg-game-fullscreen .game-container {',
    '  max-height: calc(100dvh - var(--tg-safe-top, 0px) - var(--tg-safe-bottom, 0px)) !important;',
    '}',
    'body.tg-game-fullscreen #btnBack { display: none !important; }'
  ].join('\n');
  document.head.appendChild(style);

  function applySafeInsets(topPx, bottomPx, isTg) {
    var root = document.documentElement;
    if (typeof topPx === 'number' && topPx >= 0) {
      root.style.setProperty('--tg-safe-top', topPx + 'px');
    }
    if (typeof bottomPx === 'number' && bottomPx >= 0) {
      root.style.setProperty('--tg-safe-bottom', bottomPx + 'px');
    }
    if (isTg && document.body) {
      document.body.classList.add('tg-game-fullscreen');
    }
  }

  function hideIframeGateModals() {
    if (window.self !== window.top) {
      var gate = document.getElementById('gateModal');
      if (gate) gate.classList.remove('visible');
      var notice = document.getElementById('direct-launch-notice');
      if (notice) notice.style.display = 'none';
    }
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data || {};
    if (d.type === 'INIT' || d.type === 'SAFE_AREA') {
      if (Number.isFinite(Number(d.balance))) {
        window.__HULU_INITIAL_BALANCE__ = Number(d.balance);
      }
      applySafeInsets(Number(d.safeTop || 0), Number(d.safeBottom || 0), Boolean(d.isTelegram));
      hideIframeGateModals();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hideIframeGateModals);
  } else {
    hideIframeGateModals();
  }
})();
