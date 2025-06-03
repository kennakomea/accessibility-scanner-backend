import pino from 'pino';
import fs from 'fs';
import express, { Request, Response } from 'express';

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

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// A simple root route
app.get('/', (req: Request, res: Response) => {
  res.send('API Service is running!');
});

// Health check endpoint - useful for ECS, Kubernetes, Docker health checks
app.get('/healthz', (req: Request, res: Response) => {
  // Create the health signal file on demand for health checks
  // This replaces the on-startup file creation for more dynamic health status
  try {
    fs.writeFileSync('/tmp/healthy', 'API is healthy at ' + new Date().toISOString());
    res.status(200).send({ status: 'healthy', message: 'API is healthy' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to write health signal file');
    res.status(500).send({ status: 'unhealthy', message: 'Failed to write health signal' });
  }
});

// Start the server
const server = app.listen(port, () => {
  logger.info(`API server listening on port ${port}`);
  // No longer creating /tmp/healthy on startup, it's done by /healthz endpoint.
  // However, for the initial file-based healthcheck in docker-compose to pass before /healthz is hit,
  // we can create it here once, and /healthz will update it.
  try {
    fs.writeFileSync('/tmp/healthy', 'API is starting...');
    logger.info('Initial health signal file /tmp/healthy created for API.');
  } catch (error) {
    logger.error({ err: error }, 'Failed to create initial health signal file.');
  }
});

// Graceful shutdown handlers
const signals = { 'SIGINT': 2, 'SIGTERM': 15 };

function shutdown(signal: keyof typeof signals, value: number) {
  logger.warn(`Received signal ${signal}. Shutting down gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed.');
    // In a real app, close database connections, message queues, etc.
    try {
      if (fs.existsSync('/tmp/healthy')) {
        fs.unlinkSync('/tmp/healthy');
        logger.info('Health signal file /tmp/healthy removed.');
      }
    } catch (err) {
      logger.error({ err }, 'Error removing health signal file during shutdown.');
    }
    process.exit(128 + value);
  });
}

Object.keys(signals).forEach((signal) => {
  process.on(signal as keyof typeof signals, () => {
    shutdown(signal as keyof typeof signals, signals[signal as keyof typeof signals]);
  });
});
