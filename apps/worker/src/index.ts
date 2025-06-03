import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
});

logger.info('Worker service starting...');

function main() {
  logger.info('Worker processing tasks...');
  // Placeholder for actual worker logic (e.g., connecting to Redis/Postgres, processing jobs)
  setInterval(() => {
    // logger.debug('Worker heartbeat: still alive and processing...');
  }, 10000);
}

main();
