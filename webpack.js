// Build-time helper: bake the commit the app is being built from into the
// bundle, so the running app can tell whether it is older than the source.
//
// Checking HEAD at runtime is not enough. Pulling moves HEAD while the built
// app stays on the old code, so an app that compares HEAD with the remote
// reports itself up to date while running stale — the update button then does
// nothing visible and looks broken.

const { execFileSync } = require('child_process');

/**
 * The commit HEAD points at, or '' when git is unavailable (a tarball build,
 * a machine without git). An empty value makes the updater fall back to
 * comparing HEAD, which still works — it just cannot detect a stale build.
 *
 * @param {string} [cwd] where to ask git (default: process.cwd())
 */
function currentCommit(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
}

/**
 * A webpack DefinePlugin that injects the build commit.
 *
 * Add it to the *main* process config, then pass the global to initGitUpdater:
 *
 *   // webpack.main.config.js
 *   const { buildCommitDefinePlugin } = require('electron-git-updater/webpack')
 *   plugins: [buildCommitDefinePlugin()]
 *
 *   // src/index.ts
 *   declare const BUILD_COMMIT: string
 *   initGitUpdater({ window, buildCommit: BUILD_COMMIT })
 *
 * @param {object} [options]
 * @param {string} [options.name] global to define (default 'BUILD_COMMIT')
 * @param {string} [options.cwd] where to ask git
 * @param {any} [options.webpack] webpack module to use — pass it when the host
 *   app's webpack is not resolvable from this package
 */
function buildCommitDefinePlugin(options = {}) {
  const { name = 'BUILD_COMMIT', cwd, webpack } = options;
  // Resolved lazily: webpack is the host app's dependency, not this package's.
  const wp = webpack || require('webpack');
  return new wp.DefinePlugin({ [name]: JSON.stringify(currentCommit(cwd)) });
}

module.exports = { currentCommit, buildCommitDefinePlugin };
