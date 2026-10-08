// pm2 process file for the VPS worker. From the repository root on the VPS:
//   pm2 startOrReload deploy/ecosystem.config.js && pm2 save
// Paths are resolved from this file, so the clone can live anywhere; if you copied the files
// by hand instead of cloning, keep this file in <app dir>/deploy/ or set APP_DIR below to the
// absolute path of the app directory on the VPS (the folder holding worker.py, .env and venv/).
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'utm-moodle-tracker',
      cwd: APP_DIR,
      script: path.join(APP_DIR, 'worker.py'),
      interpreter: path.join(APP_DIR, 'venv', 'bin', 'python'),
      // The worker reads everything else from <app dir>/.env; only unbuffered output is set here,
      // so pm2 logs show lines as they are printed.
      env: {
        PYTHONUNBUFFERED: '1',
      },
      // Timestamped logs (rotate them with pm2-logrotate).
      time: true,
      log_date_format: 'YYYY-MM-DDTHH:mm:ssZ',
      // A stop is honoured at a step boundary: give the in-flight user sync (Moodle calls with 15 s
      // timeouts, a bulk upsert) plus the final history flush and heartbeat time to finish before
      // pm2 sends SIGKILL.
      kill_timeout: 90000,
      // Restart forever, backing off from 5 s when it keeps crashing (no max_restarts on purpose).
      autorestart: true,
      exp_backoff_restart_delay: 5000,
    },
  ],
};
