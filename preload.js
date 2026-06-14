// Preload-process side of electron-git-updater.
//
// Call exposeGitUpdater() from your preload script to expose a small, safe API
// on `window.<key>` (default `window.gitUpdater`). It does not touch any other
// bridge you may already expose (e.g. `window.electron`).

const { contextBridge, ipcRenderer } = require('electron');

const IPC_CHECK = 'git-updater:check';
const IPC_APPLY = 'git-updater:apply';
const EVT_STATUS = 'git-updater:status';

/**
 * @param {string} [key] global name to expose the API under (default 'gitUpdater')
 */
function exposeGitUpdater(key = 'gitUpdater') {
  contextBridge.exposeInMainWorld(key, {
    // Force an immediate check; resolves with the latest status.
    check: () => ipcRenderer.invoke(IPC_CHECK),
    // Start the update (app will quit and relaunch).
    apply: () => ipcRenderer.invoke(IPC_APPLY),
    // Subscribe to periodic status pushes; returns an unsubscribe function.
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on(EVT_STATUS, listener);
      return () => ipcRenderer.removeListener(EVT_STATUS, listener);
    },
  });
}

module.exports = { exposeGitUpdater };
