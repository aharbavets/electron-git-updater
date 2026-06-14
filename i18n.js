// Built-in translations for the update banner. The host app can override any
// string via the `messages` option, so this is just a sensible fallback.

// `availableManual` is shown instead of `available` when the incoming update
// changes install hooks or dependencies — the user is asked to review and
// update by hand rather than getting a one-click button.
const DICT = {
  en: {
    available: 'Update available', update: 'Update', updating: 'Updating…', upToDate: 'Up to date',
    availableManual: 'Update available — it changes dependencies or install scripts. Review the changes and update manually.',
  },
  ru: {
    available: 'Доступно обновление', update: 'Обновить', updating: 'Обновление…', upToDate: 'Актуальная версия',
    availableManual: 'Доступно обновление — оно меняет зависимости или install-скрипты. Проверьте изменения и обновите вручную.',
  },
  be: {
    available: 'Даступнае абнаўленне', update: 'Абнавіць', updating: 'Абнаўленне…', upToDate: 'Актуальная версія',
    availableManual: 'Даступнае абнаўленне — яно змяняе залежнасці або install-скрыпты. Праверце змены і абнавіце ўручную.',
  },
  uk: {
    available: 'Доступне оновлення', update: 'Оновити', updating: 'Оновлення…', upToDate: 'Актуальна версія',
    availableManual: 'Доступне оновлення — воно змінює залежності або install-скрипти. Перевірте зміни та оновіть вручну.',
  },
  pl: {
    available: 'Dostępna aktualizacja', update: 'Aktualizuj', updating: 'Aktualizowanie…', upToDate: 'Aktualna wersja',
    availableManual: 'Dostępna aktualizacja — zmienia zależności lub skrypty instalacyjne. Sprawdź zmiany i zaktualizuj ręcznie.',
  },
  de: {
    available: 'Update verfügbar', update: 'Aktualisieren', updating: 'Wird aktualisiert…', upToDate: 'Aktuell',
    availableManual: 'Update verfügbar — es ändert Abhängigkeiten oder Install-Skripte. Bitte prüfen und manuell aktualisieren.',
  },
  es: {
    available: 'Actualización disponible', update: 'Actualizar', updating: 'Actualizando…', upToDate: 'Actualizado',
    availableManual: 'Actualización disponible — cambia dependencias o scripts de instalación. Revísalo y actualiza manualmente.',
  },
  fr: {
    available: 'Mise à jour disponible', update: 'Mettre à jour', updating: 'Mise à jour…', upToDate: 'À jour',
    availableManual: "Mise à jour disponible — elle modifie des dépendances ou des scripts d'installation. Vérifiez et mettez à jour manuellement.",
  },
};

// Resolve a single key for a given locale, falling back to English.
function translate(locale, key) {
  const lang = String(locale || 'en').slice(0, 2).toLowerCase();
  const table = DICT[lang] || DICT.en;
  return table[key] || DICT.en[key] || key;
}

module.exports = { DICT, translate };
