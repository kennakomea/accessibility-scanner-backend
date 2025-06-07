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
// SQL to create the table (run this manually or via a migration script):
/*
CREATE TABLE scan_results (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(255) UNIQUE,
  original_job_id VARCHAR(255),
  submitted_url TEXT NOT NULL,
  actual_url TEXT,
  scan_timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  page_title TEXT,
  scan_success BOOLEAN NOT NULL,
  violations JSONB,
  error_message TEXT
);
*/
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
  let actualUrl;
  let pageTitleFromScan;
  let scanSucceeded = false;
  let axeScanResults: axe.AxeResults | undefined;
  let processingError: Error | undefined;
  let dbErrorMessage: string | undefined;
  let pageScreenshotBase64: string | undefined;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      protocolTimeout: 90000, // 90 seconds
    });
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(30000);

    const urlToScan = job.data?.submittedUrl || 'https://example.com';
    logger.info({ jobId: job.id, url: urlToScan }, 'Navigating to page');
    const response = await page.goto(urlToScan, { waitUntil: 'networkidle2' });
    actualUrl = response?.url() || urlToScan; // Get actual URL after redirects

    pageTitleFromScan = await page.title();
    logger.info(
      { jobId: job.id, title: pageTitleFromScan, actualUrl },
      'Page title retrieved',
    );

    if (!pageTitleFromScan) {
      logger.warn({ jobId: job.id, url: actualUrl }, 'Page title is empty');
    }

    const axeScript = await fs.promises.readFile(
      require.resolve('axe-core'),
      'utf8',
    );
    await page.evaluate(axeScript);

    // Capture screenshot after page load and before Axe scan
    try {
      pageScreenshotBase64 = await page.screenshot({
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

    axeScanResults = (await page.evaluate(() => {
      // @ts-expect-error TS2304: Cannot find name 'window'. 'window' is a browser global.
      return (window as unknown as AxeContext).axe.run();
    })) as axe.AxeResults;

    logger.info(
      { jobId: job.id, violations: axeScanResults.violations.length },
      'Axe-core scan completed',
    );

    if (axeScanResults.violations.length > 0) {
      logger.warn(
        { jobId: job.id, violations: axeScanResults.violations },
        'Accessibility violations found',
      );
    }
    scanSucceeded = true;
    logger.info(
      { jobId: job.id },
      'Job processing completed successfully by Puppeteer/Axe',
    );
  } catch (e: unknown) {
    let errMessage =
      'An unknown error occurred during Puppeteer or Axe-core processing';
    let errStack: string | undefined;
    let caughtError: Error;

    if (e instanceof Error) {
      errMessage = e.message;
      errStack = e.stack;
      caughtError = e;
    } else if (typeof e === 'string') {
      errMessage = e;
      caughtError = new Error(e);
    } else {
      caughtError = new Error(errMessage);
    }
    processingError = caughtError;

    logger.error(
      { jobId: job.id, error: errMessage, stack: errStack },
      'Error during Puppeteer or Axe-core processing',
    );
  } finally {
    if (browser) {
      await browser.close();
      logger.info({ jobId: job.id }, 'Browser closed');
    }
  }

  let dbSaveSuccess = false;
  if (scanSucceeded) {
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
        actualUrl,
        pageTitleFromScan,
        true,
        JSON.stringify(axeScanResults?.violations),
        null,
        pageScreenshotBase64 || null,
      ];
      const res = await pool.query(insertQuery, values);
      logger.info(
        { jobId: job.id, dbRecordId: res.rows[0].id },
        'Scan result saved to database',
      );
      dbSaveSuccess = true;
    } catch (dbErrUnknown: unknown) {
      let specificErrorMsg = 'Unknown database error';
      let errorStack: string | undefined;
      if (dbErrUnknown instanceof Error) {
        specificErrorMsg = dbErrUnknown.message;
        errorStack = dbErrUnknown.stack;
      } else if (typeof dbErrUnknown === 'string') {
        specificErrorMsg = dbErrUnknown;
      }
      dbErrorMessage = `Failed to save scan result to database: ${specificErrorMsg}`;
      logger.error(
        { jobId: job.id, error: specificErrorMsg, stack: errorStack },
        dbErrorMessage,
      );
    }
  } else {
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
        actualUrl,
        pageTitleFromScan,
        false,
        null,
        processingError?.message,
        pageScreenshotBase64 || null,
      ];
      const res = await pool.query(insertQuery, values);
      logger.info(
        { jobId: job.id, dbRecordId: res.rows[0].id },
        'Scan failure attempt logged to database',
      );
      dbSaveSuccess = true;
    } catch (dbErrUnknown: unknown) {
      let specificErrorMsg =
        'Unknown database error while saving failure record';
      let errorStack: string | undefined;
      if (dbErrUnknown instanceof Error) {
        specificErrorMsg = dbErrUnknown.message;
        errorStack = dbErrUnknown.stack;
      } else if (typeof dbErrUnknown === 'string') {
        specificErrorMsg = dbErrUnknown;
      }
      dbErrorMessage = `Failed to save scan failure record to database: ${specificErrorMsg}`;
      logger.error(
        {
          jobId: job.id,
          error: specificErrorMsg,
          stack: errorStack,
          originalProcessingError: processingError?.message,
        },
        dbErrorMessage,
      );
    }
  }

  const overallJobSuccess = scanSucceeded && dbSaveSuccess;

  if (overallJobSuccess) {
    return {
      success: true,
      jobId: job.id,
      data: job.data,
      violations: axeScanResults!.violations,
      pageTitle: pageTitleFromScan,
      actualUrl: actualUrl,
    };
  } else {
    let finalErrorMessage = processingError?.message || '';
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
      pageTitle: pageTitleFromScan,
      actualUrl: actualUrl,
    };
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
