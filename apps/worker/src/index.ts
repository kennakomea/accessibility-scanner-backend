import pino from 'pino';
import { Worker, Job } from 'bullmq';
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

const SCAN_QUEUE_NAME = 'scan-jobs';
const redisConnectionOptions = {
  host: process.env.REDIS_HOST || 'redis', // From docker-compose
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  // Add maxRetriesPerRequest: null if you see connection issues in logs
  // maxRetriesPerRequest: null,
};

logger.info('Worker service starting...');

// Define an interface for the job data and result
interface ScanJobData {
  submittedUrl: string;
  originalJobId: string;
}

interface ScanJobResult {
  success: boolean;
  jobId: string | undefined;
  data: ScanJobData | undefined;
}

// Define the job processing function
async function processScanJob(
  job: Job<ScanJobData, ScanJobResult>,
): Promise<ScanJobResult> {
  logger.info(
    { jobId: job.id, jobName: job.name, data: job.data },
    'Processing job',
  );
  // Simulate work
  await new Promise((resolve) => setTimeout(resolve, 5000)); // 5 seconds delay
  logger.info({ jobId: job.id }, 'Job processing completed');
  // In a real scenario, you would update job status, store results, etc.
  return { success: true, jobId: job.id, data: job.data };
}

// Initialize the BullMQ Worker
const worker = new Worker<ScanJobData, ScanJobResult>(
  SCAN_QUEUE_NAME,
  processScanJob,
  {
    connection: redisConnectionOptions,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
    removeOnComplete: { count: 1000 }, // Keep up to 1000 completed jobs
    removeOnFail: { count: 5000 }, // Keep up to 5000 failed jobs
  },
);

worker.on(
  'completed',
  (job: Job<ScanJobData, ScanJobResult>, result: ScanJobResult) => {
    logger.info({ jobId: job.id, result }, `Job completed`);
  },
);

worker.on(
  'failed',
  (job: Job<ScanJobData, ScanJobResult> | undefined, err: Error) => {
    if (job) {
      logger.error(
        { jobId: job.id, error: err.message, stack: err.stack },
        `Job failed`,
      );
    } else {
      logger.error(
        { error: err.message, stack: err.stack },
        `Job failed (job data unavailable)`,
      );
    }
  },
);

worker.on('error', (err: Error) => {
  logger.error({ error: err.message, stack: err.stack }, 'BullMQ worker error');
});

worker.on('ready', () => {
  logger.info(
    `Worker is ready and listening for jobs on queue '${SCAN_QUEUE_NAME}'. Concurrency: ${worker.opts.concurrency}`,
  );
  // Create a health signal file when the worker is ready
  try {
    fs.writeFileSync(
      '/tmp/healthy_worker',
      'Worker is healthy at ' + new Date().toISOString(),
    );
    logger.info('Health signal file /tmp/healthy_worker created for Worker.');
  } catch (error) {
    logger.error(
      { err: error },
      'Failed to create health signal file for Worker.',
    );
  }
});

logger.info('Worker initialized. Waiting for jobs...');

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down worker gracefully...');
  await worker.close();
  try {
    if (fs.existsSync('/tmp/healthy_worker')) {
      fs.unlinkSync('/tmp/healthy_worker');
      logger.info('Health signal file /tmp/healthy_worker removed.');
    }
  } catch (err) {
    logger.error(
      { err },
      'Error removing health signal file during shutdown for Worker.',
    );
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
