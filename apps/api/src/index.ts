import pino from 'pino';
import fs from 'fs';

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
  // Create a health signal file
  fs.writeFileSync('/tmp/healthy', 'API is healthy');
  logger.info('Health signal file /tmp/healthy created for API.');
}

startServer();

// Graceful shutdown handlers
const signals = { 'SIGINT': 2, 'SIGTERM': 15 };

function shutdown(signal: keyof typeof signals, value: number) {
  logger.warn(`Received signal ${signal}. Shutting down gracefully...`);
  // In a real app, close database connections, message queues, etc.
  // For now, we just remove the health signal file if it exists
  try {
    if (fs.existsSync('/tmp/healthy')) {
      fs.unlinkSync('/tmp/healthy');
      logger.info('Health signal file /tmp/healthy removed.');
    }
  } catch (err) {
    logger.error({ err }, 'Error removing health signal file during shutdown.');
  }
  process.exit(128 + value);
}

Object.keys(signals).forEach((signal) => {
  process.on(signal as keyof typeof signals, () => {
    shutdown(signal as keyof typeof signals, signals[signal as keyof typeof signals]);
  });
});
