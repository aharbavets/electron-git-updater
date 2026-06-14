// Convenience re-exports. Note the three pieces run in *different* Electron
// processes — import them from their subpaths in the matching process instead
// of pulling everything through this file:
//
//   const { initGitUpdater } = require('electron-git-updater/main');     // main
//   const { exposeGitUpdater } = require('electron-git-updater/preload'); // preload
//   const { mountUpdateBanner } = require('electron-git-updater/renderer'); // renderer
//
// Only the process-neutral i18n helper is safe to expose here.

const { translate, DICT } = require('./i18n');

module.exports = { translate, DICT };
