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

logger.info('API service starting...');

const port = process.env.PORT || 3000;

// Placeholder for actual server setup (e.g., Express)
function startServer() {
  logger.info(`API server listening on port ${port}`);
}

startServer();
