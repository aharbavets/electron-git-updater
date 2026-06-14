// Renderer-process side of electron-git-updater.
//
// mountUpdateBanner() injects a framework-agnostic banner (plain DOM, styled
// with Bootstrap classes if present) that appears only when an update is
// available. For a normal update it offers a one-click button; for a *risky*
// update (one that changes install hooks or dependencies) it instead asks the
// user to review and update manually, and lists what changed.

const { translate } = require('./i18n');

/**
 * @param {object} [opts]
 * @param {object} [opts.api] the bridge object (default window.gitUpdater)
 * @param {string} [opts.locale] BCP-47 locale for built-in strings (default navigator.language)
 * @param {object} [opts.messages] explicit string overrides
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
    '<div data-egu-alert class="alert d-flex flex-column align-items-center mb-0 rounded-0 shadow-sm" role="alert" style="border-left:0;border-right:0;">' +
    '<div class="d-flex align-items-center justify-content-center gap-3">' +
    '<span data-egu-text></span>' +
    '<button type="button" class="btn btn-sm btn-primary" data-egu-btn></button>' +
    '</div>' +
    '<ul data-egu-reasons class="small mb-0 mt-1 ps-3" style="opacity:.85;"></ul>' +
    '</div>';
  document.body.appendChild(el);

  const alertEl = el.querySelector('[data-egu-alert]');
  const textEl = el.querySelector('[data-egu-text]');
  const reasonsEl = el.querySelector('[data-egu-reasons]');
  const btn = el.querySelector('[data-egu-btn]');

  function setReasons(reasons) {
    reasonsEl.innerHTML = '';
    if (!reasons || !reasons.length) {
      reasonsEl.style.display = 'none';
      return;
    }
    for (const reason of reasons) {
      const li = document.createElement('li');
      li.textContent = reason;
      reasonsEl.appendChild(li);
    }
    reasonsEl.style.display = '';
  }

  // Render from a status object pushed by the main process.
  function render(status) {
    if (!status || !status.available) {
      el.style.display = 'none';
      return;
    }
    if (status.risky) {
      // Risky: no auto-update. Ask to update manually and show what changed.
      alertEl.className =
        'alert alert-warning d-flex flex-column align-items-center mb-0 rounded-0 shadow-sm';
      textEl.textContent = t('availableManual');
      btn.style.display = 'none';
      setReasons(status.reasons);
    } else {
      alertEl.className =
        'alert alert-info d-flex flex-column align-items-center mb-0 rounded-0 shadow-sm';
      textEl.textContent = t('available');
      btn.textContent = t('update');
      btn.disabled = false;
      btn.style.display = '';
      setReasons(null);
    }
    el.style.display = 'block';
  }

  btn.addEventListener('click', async () => {
    textEl.textContent = t('updating');
    btn.disabled = true;
    try {
      const result = await api.apply();
      // Server-side may still refuse (e.g. risk appeared between check & apply).
      if (result && result.blocked) render({ available: true, risky: true, reasons: result.reasons });
    } catch (error) {
      console.error('[git-updater] apply failed', error);
    }
  });

  const unsubscribe = api.onStatus ? api.onStatus(render) : null;

  Promise.resolve(api.check ? api.check() : null)
    .then(render)
    .catch(() => {});

  return function unmount() {
    if (unsubscribe) unsubscribe();
    el.remove();
  };
}

module.exports = { mountUpdateBanner };
