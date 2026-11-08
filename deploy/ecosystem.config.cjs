// pm2 process file · `pm2 startOrRestart deploy/ecosystem.config.cjs --update-env`
const path = require("node:path");
module.exports = {
  apps: [{
    name: "gyre",
    cwd: path.join(__dirname, "..", "server"),
    script: "server.js",
    env: { NODE_ENV: "production", PORT: 5520 },
    max_memory_restart: "400M",
    time: true,
    autorestart: true,
    max_restarts: 20,
  }],
};
