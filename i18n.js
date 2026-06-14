// Built-in translations for the update banner. The host app can override any
// string via the `messages` option, so this is just a sensible fallback.

const DICT = {
  en: { available: 'Update available', update: 'Update', updating: 'Updating…', upToDate: 'Up to date' },
  ru: { available: 'Доступно обновление', update: 'Обновить', updating: 'Обновление…', upToDate: 'Актуальная версия' },
  be: { available: 'Даступнае абнаўленне', update: 'Абнавіць', updating: 'Абнаўленне…', upToDate: 'Актуальная версія' },
  uk: { available: 'Доступне оновлення', update: 'Оновити', updating: 'Оновлення…', upToDate: 'Актуальна версія' },
  pl: { available: 'Dostępna aktualizacja', update: 'Aktualizuj', updating: 'Aktualizowanie…', upToDate: 'Aktualna wersja' },
  de: { available: 'Update verfügbar', update: 'Aktualisieren', updating: 'Wird aktualisiert…', upToDate: 'Aktuell' },
  es: { available: 'Actualización disponible', update: 'Actualizar', updating: 'Actualizando…', upToDate: 'Actualizado' },
  fr: { available: 'Mise à jour disponible', update: 'Mettre à jour', updating: 'Mise à jour…', upToDate: 'À jour' },
};

// Resolve a single key for a given locale, falling back to English.
function translate(locale, key) {
  const lang = String(locale || 'en').slice(0, 2).toLowerCase();
  const table = DICT[lang] || DICT.en;
  return table[key] || DICT.en[key] || key;
}

module.exports = { DICT, translate };
