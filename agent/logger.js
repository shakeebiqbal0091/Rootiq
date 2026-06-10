// agent/logger.js — Structured logger for DevOps Intelligence Agent

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const COLORS = {
  debug: '\x1b[36m',
  info:  '\x1b[32m',
  warn:  '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
  dim:   '\x1b[2m',
};

const currentLevel = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function log(level, message, meta = {}) {
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const color = COLORS[level] ?? '';
  const reset = COLORS.reset;
  const dim = COLORS.dim;
  const metaStr = Object.keys(meta).length
    ? ' ' + dim + JSON.stringify(meta) + reset
    : '';
  const line = `${dim}[${ts}]${reset} ${color}${level.toUpperCase().padEnd(5)}${reset} ${message}${metaStr}`;
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};

export default logger;