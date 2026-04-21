'use strict';

const path = require('path');
const fs = require('fs');
const winston = require('winston');
require('winston-daily-rotate-file');

const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const SENSITIVE_KEYS = /(password|token|secret|api[_-]?key|authorization|cookie|session)/i;

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function redact(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redact(v);
  }
  return out;
}

const PRESERVED = new Set(['level', 'message', 'timestamp', 'label', Symbol.for('level'), Symbol.for('message'), Symbol.for('splat')]);

const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (PRESERVED.has(key)) continue;
    info[key] = redact(info[key]);
    if (typeof key === 'string' && SENSITIVE_KEYS.test(key)) {
      info[key] = '[REDACTED]';
    }
  }
  return info;
});

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  redactFormat(),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...rest }) => {
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(redact(rest))}` : '';
    return `${timestamp} ${level}: ${message}${extra}`;
  })
);

const rotateTransport = new winston.transports.DailyRotateFile({
  filename: path.join(LOG_DIR, 'app-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '10m',
  maxFiles: '14d',
  zippedArchive: true,
  format: fileFormat,
});

const errorTransport = new winston.transports.DailyRotateFile({
  filename: path.join(LOG_DIR, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '10m',
  maxFiles: '30d',
  zippedArchive: true,
  level: 'error',
  format: fileFormat,
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    rotateTransport,
    errorTransport,
    new winston.transports.Console({ format: consoleFormat }),
  ],
  exitOnError: false,
});

module.exports = { logger, redact };
