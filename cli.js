#!/usr/bin/env node
'use strict';

// The same update, run from a terminal instead of from the app's button.
//
// Host apps used to carry a hand-written update.sh that did `git pull && npm
// install && npm run package`. That is the unsafe update this library exists
// to replace: it installs whatever the incoming commits ask for, without
// showing anyone the diff. Running the generated script instead means the
// by-hand path and the in-app path are the same path, and stay in step.
//
// Risky changes are allowed to be confirmed here by default, because there is
// by definition a person at a terminal: the script prints the diff and asks
// for the phrase. `--no-risk` restores the plain refusal.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  buildUpdateScript,
  checkUpdaterVersion,
  resolveBashPath,
  resolveRepoPath,
  RISK_CONFIRMATION,
} = require('./main.js');

function usage() {
  console.log(`usage: electron-git-updater update [--repo <path>] [--no-risk]

  update       pull, check what the commits want to install, build, in this terminal
  --repo       source checkout to update (default: the current directory)
  --no-risk    refuse outright when commits change dependencies, instead of
               offering to confirm with ${RISK_CONFIRMATION}`);
}

async function main(argv) {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return 0;
  }
  if (command !== 'update') {
    console.error(`unknown command: ${command}`);
    usage();
    return 2;
  }

  const repoArg = argv.indexOf('--repo');
  const repoPath = resolveRepoPath(
    repoArg !== -1 ? argv[repoArg + 1] : process.cwd()
  );
  const allowRisky = !argv.includes('--no-risk');

  let appName = 'the app';
  try {
    appName = JSON.parse(
      fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')
    ).name || appName;
  } catch (_) {
    /* no manifest — the name is cosmetic */
  }

  const bash = resolveBashPath();
  if (!bash) {
    console.error('no bash found to run the update script.');
    return 1;
  }

  const script = buildUpdateScript({
    repoPath,
    // 0 means "nothing to wait for": the app is not what launched this, so the
    // script must not sit waiting for a process to quit.
    parentPid: 0,
    appName,
    updater: await checkUpdaterVersion(repoPath),
    allowRisky,
  });

  const scriptPath = path.join(os.tmpdir(), `electron-git-updater-cli-${process.pid}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  // Inherited stdio on purpose: this runs in the terminal the user is already
  // looking at, so the prompt is answerable and the output is theirs.
  const code = await new Promise((resolve) => {
    const child = spawn(bash, [scriptPath], { stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(String((error && error.message) || error));
      resolve(1);
    });
    child.on('exit', (status) => resolve(status === null ? 1 : status));
  });

  try {
    fs.unlinkSync(scriptPath);
  } catch (_) {
    /* already gone */
  }
  return code;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(String((error && error.message) || error));
    process.exit(1);
  }
);
