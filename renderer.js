// Renderer-process side of electron-git-updater.
//
// mountUpdateBanner() injects a framework-agnostic banner (plain DOM, styled
// with Bootstrap classes if present) that appears only when an update is
// available and triggers the update on click. It is deliberately not tied to
// any React version so it can drop into different apps unchanged.

const { translate } = require('./i18n');

/**
 * @param {object} [opts]
 * @param {object} [opts.api] the bridge object (default window.gitUpdater)
 * @param {string} [opts.locale] BCP-47 locale for built-in strings (default navigator.language)
 * @param {object} [opts.messages] explicit string overrides ({ available, update, updating })
 * @returns {() => void} unmount function
 */
function mountUpdateBanner(opts = {}) {
  const api = opts.api || (typeof window !== 'undefined' ? window.gitUpdater : null);
  const locale =
    opts.locale || (typeof navigator !== 'undefined' && navigator.language) || 'en';
  const messages = opts.messages || {};
  const t = (key) => messages[key] || translate(locale, key);

  if (!api) {
    console.warn('[git-updater] window.gitUpdater not found — did the preload call exposeGitUpdater()?');
    return () => {};
  }

  const el = document.createElement('div');
  el.setAttribute('data-git-updater', '');
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2000;display:none;';
  el.innerHTML =
    '<div class="alert alert-info d-flex align-items-center justify-content-center gap-3 mb-0 rounded-0 shadow-sm" role="alert" style="border-left:0;border-right:0;">' +
    '<span data-egu-text></span>' +
    '<button type="button" class="btn btn-sm btn-primary" data-egu-btn></button>' +
    '</div>';
  document.body.appendChild(el);

  const textEl = el.querySelector('[data-egu-text]');
  const btn = el.querySelector('[data-egu-btn]');

  function render(state) {
    if (state === 'available') {
      textEl.textContent = t('available');
      btn.textContent = t('update');
      btn.disabled = false;
      el.style.display = 'block';
    } else if (state === 'updating') {
      textEl.textContent = t('updating');
      btn.disabled = true;
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  }

  btn.addEventListener('click', async () => {
    render('updating');
    try {
      await api.apply();
    } catch (error) {
      console.error('[git-updater] apply failed', error);
    }
  });

  const unsubscribe = api.onStatus
    ? api.onStatus((status) => render(status && status.available ? 'available' : 'hidden'))
    : null;

  Promise.resolve(api.check ? api.check() : null)
    .then((status) => {
      if (status && status.available) render('available');
    })
    .catch(() => {});

  return function unmount() {
    if (unsubscribe) unsubscribe();
    el.remove();
  };
}

module.exports = { mountUpdateBanner };
