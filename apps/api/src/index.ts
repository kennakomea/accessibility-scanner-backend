import pino from 'pino';
import fs from 'fs';
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { Queue } from 'bullmq';

import { scanWebsiteSchema } from './validation/scanWebsiteSchema';

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

// BullMQ Queue setup
const SCAN_QUEUE_NAME = 'scan-jobs';
const redisConnectionOptions = {
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
};

const scanQueue = new Queue(SCAN_QUEUE_NAME, {
  connection: redisConnectionOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
});

logger.info(`BullMQ queue '${SCAN_QUEUE_NAME}' initialized.`);

// Define Zod schema for URL submission
const SubmitUrlSchema = z.object({
  url: z.string().url({ message: 'Invalid URL format' }),
});

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
    fs.writeFileSync(
      '/tmp/healthy',
      'API is healthy at ' + new Date().toISOString(),
    );
    res.status(200).send({ status: 'healthy', message: 'API is healthy' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to write health signal file');
    res
      .status(500)
      .send({ status: 'unhealthy', message: 'Failed to write health signal' });
  }
});

// New endpoint for scan-website
app.post('/api/scan-website', async (req: Request, res: Response) => {
  const validationResult = scanWebsiteSchema.safeParse(req.body);

  if (!validationResult.success) {
    logger.error(
      { error: validationResult.error.issues },
      'Invalid request body for /api/scan-website',
    );
    return res.status(400).send({
      message: 'Invalid request body',
      errors: validationResult.error.issues,
    });
  }

  const { url } = validationResult.data;
  const jobId = uuidv4();

  try {
    // Add job to the BullMQ queue
    await scanQueue.add(
      'scan-url',
      { submittedUrl: url, originalJobId: jobId },
      { jobId: jobId },
    );

    logger.info(
      { submittedUrl: url, jobId },
      `Job enqueued successfully in '${SCAN_QUEUE_NAME}'`,
    );

    res.status(202).send({
      message: 'Scan request accepted and enqueued. Job ID: ' + jobId,
      jobId: jobId,
      submittedUrl: url,
    });
  } catch (error) {
    logger.error(
      { err: error, submittedUrl: url, jobId },
      `Failed to enqueue job in '${SCAN_QUEUE_NAME}'`,
    );
    res.status(500).send({
      message: 'Failed to enqueue scan request. Please try again later.',
    });
  }
});

// Endpoint to submit a URL for scanning
app.post('/api/submit-url', (req: Request, res: Response) => {
  try {
    // Validate request body
    const validatedData = SubmitUrlSchema.parse(req.body);
    const { url } = validatedData;

    logger.info({ submittedUrl: url }, 'Received URL for scanning');

    // TODO: Add URL to Redis queue for the worker (Task 3.2)

    res.status(200).send({ message: 'URL received successfully', url });
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error(
        { error: error.issues },
        'Invalid request body for URL submission',
      );
      return res
        .status(400)
        .send({ message: 'Invalid request body', errors: error.issues });
    }
    logger.error({ errorDetails: error }, 'Error processing URL submission');
    res.status(500).send({ message: 'Internal server error' });
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
    logger.error(
      { err: error },
      'Failed to create initial health signal file.',
    );
  }
});

// Graceful shutdown handlers
const signals = { SIGINT: 2, SIGTERM: 15 };

async function shutdown(signal: keyof typeof signals, value: number) {
  logger.warn(`Received signal ${signal}. Shutting down gracefully...`);

  // Close BullMQ queue
  try {
    await scanQueue.close();
    logger.info(`BullMQ queue '${SCAN_QUEUE_NAME}' closed.`);
  } catch (err) {
    logger.error({ err }, `Error closing BullMQ queue '${SCAN_QUEUE_NAME}'.`);
  }

  server.close(() => {
    logger.info('HTTP server closed.');
    // In a real app, close database connections, message queues, etc.
    try {
      if (fs.existsSync('/tmp/healthy')) {
        fs.unlinkSync('/tmp/healthy');
        logger.info('Health signal file /tmp/healthy removed.');
      }
    } catch (err) {
      logger.error(
        { err },
        'Error removing health signal file during shutdown.',
      );
    }
    process.exit(128 + value);
  });
}

Object.keys(signals).forEach((signal) => {
  process.on(signal as keyof typeof signals, () => {
    shutdown(
      signal as keyof typeof signals,
      signals[signal as keyof typeof signals],
    );
  });
});
