import pino from 'pino';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const rootLogger = pino({
  level: LOG_LEVEL,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export function createLogger(service: string): pino.Logger {
  return rootLogger.child({ service });
}

export default rootLogger;
