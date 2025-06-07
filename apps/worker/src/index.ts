import pino from 'pino';
import { Worker, Job } from 'bullmq';
import fs from 'fs';
import puppeteer from 'puppeteer';
import * as axe from 'axe-core';
import { Pool } from 'pg';
import IORedis from 'ioredis';

// Define an interface for the context where axe.run is called
interface AxeContext {
  axe: typeof axe;
}

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
if (!process.env.REDIS_URL) {
  logger.error('FATAL: REDIS_URL environment variable is not set.');
  process.exit(1);
}
const connection = new IORedis(process.env.REDIS_URL + '?family=0', {
  maxRetriesPerRequest: null,
});

// PostgreSQL Connection Pool
if (!process.env.DATABASE_URL) {
  logger.error('FATAL: DATABASE_URL environment variable is not set.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('connect', () => {
  logger.info('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  logger.error(
    { error: err.message, stack: err.stack },
    'PostgreSQL pool error',
  );
});

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
  violations?: axe.Result[];
  errorMessage?: string;
  pageTitle?: string;
  actualUrl?: string;
}

// Define the job processing function
async function processScanJob(
  job: Job<ScanJobData, ScanJobResult>,
): Promise<ScanJobResult> {
  logger.info(
    { jobId: job.id, jobName: job.name, data: job.data },
    'Processing job',
  );

  let browser;
  const scanResult: {
    actualUrl?: string;
    pageTitle?: string;
    scanSucceeded: boolean;
    axeResults?: axe.AxeResults;
    processingError?: Error;
    screenshot?: string;
  } = {
    scanSucceeded: false,
  };

  try {
    // Launch Puppeteer with optimizations for containerized environments
    browser = await puppeteer.launch({
      headless: true,
      // Recommended args for running in Docker, especially in a constrained environment like Railway
      args: [
        '--no-sandbox', // Disables the Chrome sandbox, necessary for many Docker environments
        '--disable-setuid-sandbox', // Also for sandbox compatibility
        '--disable-dev-shm-usage', // Writes to /tmp instead of shared memory, preventing crashes
        '--disable-accelerated-2d-canvas', // Disables GPU hardware acceleration
        '--disable-gpu', // General GPU disable
      ],
      // Increased timeout to prevent ProtocolError on slower server starts
      protocolTimeout: 90000, // 90 seconds
    });
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(30000);

    const urlToScan = job.data?.submittedUrl || 'https://example.com';
    logger.info({ jobId: job.id, url: urlToScan }, 'Navigating to page');
    const response = await page.goto(urlToScan, { waitUntil: 'networkidle2' });
    scanResult.actualUrl = response?.url() || urlToScan;

    scanResult.pageTitle = await page.title();
    logger.info(
      {
        jobId: job.id,
        title: scanResult.pageTitle,
        actualUrl: scanResult.actualUrl,
      },
      'Page title retrieved',
    );

    if (!scanResult.pageTitle) {
      logger.warn(
        { jobId: job.id, url: scanResult.actualUrl },
        'Page title is empty',
      );
    }

    const axeScript = await fs.promises.readFile(
      require.resolve('axe-core'),
      'utf8',
    );
    await page.evaluate(axeScript);

    // Capture screenshot after page load and before Axe scan
    try {
      scanResult.screenshot = await page.screenshot({
        encoding: 'base64',
        type: 'jpeg',
        quality: 75,
      });
      logger.info({ jobId: job.id }, 'Page screenshot captured successfully.');
    } catch (screenshotError: unknown) {
      logger.warn(
        {
          jobId: job.id,
          error:
            screenshotError instanceof Error
              ? screenshotError.message
              : String(screenshotError),
        },
        'Failed to capture page screenshot.',
      );
      // Not treating screenshot failure as a critical error for the scan itself
    }

    scanResult.axeResults = (await page.evaluate(() => {
      // @ts-expect-error TS2304: Cannot find name 'window'. 'window' is a browser global.
      return (window as unknown as AxeContext).axe.run();
    })) as axe.AxeResults;

    logger.info(
      { jobId: job.id, violations: scanResult.axeResults.violations.length },
      'Axe-core scan completed',
    );

    if (scanResult.axeResults.violations.length > 0) {
      logger.warn(
        { jobId: job.id, violations: scanResult.axeResults.violations },
        'Accessibility violations found',
      );
    }
    scanResult.scanSucceeded = true;
    logger.info(
      { jobId: job.id },
      'Job processing completed successfully by Puppeteer/Axe',
    );
  } catch (e: unknown) {
    if (e instanceof Error) {
      scanResult.processingError = e;
    } else {
      scanResult.processingError = new Error(String(e));
    }

    logger.error(
      {
        jobId: job.id,
        error: scanResult.processingError.message,
        stack: scanResult.processingError.stack,
      },
      'Error during Puppeteer or Axe-core processing',
    );
  } finally {
    if (browser) {
      await browser.close();
      logger.info({ jobId: job.id }, 'Browser closed');
    }
  }

  const { dbSaveSuccess, dbErrorMessage } = await saveScanResultToDb(
    job,
    scanResult,
  );

  const overallJobSuccess = scanResult.scanSucceeded && dbSaveSuccess;

  if (overallJobSuccess) {
    return {
      success: true,
      jobId: job.id,
      data: job.data,
      violations: scanResult.axeResults!.violations,
      pageTitle: scanResult.pageTitle,
      actualUrl: scanResult.actualUrl,
    };
  } else {
    let finalErrorMessage = scanResult.processingError?.message || '';
    if (dbErrorMessage) {
      if (finalErrorMessage) finalErrorMessage += '; ';
      finalErrorMessage += dbErrorMessage;
    }
    if (!finalErrorMessage)
      finalErrorMessage = 'Unknown processing or DB error';

    return {
      success: false,
      jobId: job.id,
      data: job.data,
      errorMessage: finalErrorMessage,
      pageTitle: scanResult.pageTitle,
      actualUrl: scanResult.actualUrl,
    };
  }
}

async function saveScanResultToDb(
  job: Job<ScanJobData, ScanJobResult>,
  scanResult: {
    actualUrl?: string;
    pageTitle?: string;
    scanSucceeded: boolean;
    axeResults?: axe.AxeResults;
    processingError?: Error;
    screenshot?: string;
  },
): Promise<{ dbSaveSuccess: boolean; dbErrorMessage?: string }> {
  try {
    const insertQuery = `
      INSERT INTO scan_results
        (job_id, original_job_id, submitted_url, actual_url, page_title, scan_success, violations, error_message, page_screenshot)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id;
    `;
    const values = [
      job.id,
      job.data?.originalJobId,
      job.data?.submittedUrl,
      scanResult.actualUrl,
      scanResult.pageTitle,
      scanResult.scanSucceeded,
      scanResult.scanSucceeded
        ? JSON.stringify(scanResult.axeResults?.violations)
        : null,
      scanResult.scanSucceeded ? null : scanResult.processingError?.message,
      scanResult.screenshot || null,
    ];

    const res = await pool.query(insertQuery, values);
    logger.info(
      { jobId: job.id, dbRecordId: res.rows[0].id },
      `Scan ${
        scanResult.scanSucceeded ? 'result' : 'failure log'
      } saved to database`,
    );

    return { dbSaveSuccess: true };
  } catch (dbErr: unknown) {
    const err =
      dbErr instanceof Error ? dbErr : new Error('Unknown database error');
    const dbErrorMessage = `Failed to save scan result to database: ${err.message}`;
    logger.error(
      {
        jobId: job.id,
        error: err.message,
        stack: err.stack,
        originalProcessingError: scanResult.processingError?.message,
      },
      dbErrorMessage,
    );

    return { dbSaveSuccess: false, dbErrorMessage };
  }
}

// Initialize the BullMQ Worker
const worker = new Worker<ScanJobData, ScanJobResult>(
  SCAN_QUEUE_NAME,
  processScanJob,
  {
    connection: connection,
    concurrency: 5, // Process up to 5 jobs concurrently
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

async function shutdown() {
  logger.info('Shutting down worker gracefully...');
  await worker.close();
  await pool.end();
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
