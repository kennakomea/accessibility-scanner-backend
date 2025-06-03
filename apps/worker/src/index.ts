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

logger.info('Worker service starting...');

let workerInterval: NodeJS.Timeout | null = null;

function main() {
  logger.info('Worker processing tasks...');
  // Placeholder for actual worker logic
  workerInterval = setInterval(() => {
    // logger.debug('Worker heartbeat: still alive and processing...');
  }, 10000);

  // Create a health signal file
  fs.writeFileSync('/tmp/healthy', 'Worker is healthy');
  logger.info('Health signal file /tmp/healthy created for Worker.');
}

main();

// Graceful shutdown handlers
const signals = { 'SIGINT': 2, 'SIGTERM': 15 };
let isShuttingDown = false;

function shutdown(signal: keyof typeof signals, value: number) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.warn(`Received signal ${signal}. Shutting down gracefully...`);

  if (workerInterval) {
    clearInterval(workerInterval);
    logger.info('Worker interval cleared.');
  }

  try {
    if (fs.existsSync('/tmp/healthy')) {
      fs.unlinkSync('/tmp/healthy');
      logger.info('Health signal file /tmp/healthy removed.');
    }
  } catch (err) {
    logger.error({ err }, 'Error removing health signal file during shutdown.');
  }

  // Allow a short delay for logs to flush before exiting
  setTimeout(() => {
    logger.info('Exiting worker process.');
    process.exit(128 + value);
  }, 500); // Reduced timeout, 1s was a bit long for simple cleanup
}

Object.keys(signals).forEach((signal) => {
  process.on(signal as keyof typeof signals, () => {
    shutdown(signal as keyof typeof signals, signals[signal as keyof typeof signals]);
  });
});
