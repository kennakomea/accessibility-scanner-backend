import pino from 'pino';
import fs from 'fs';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import IORedis from 'ioredis';
// import puppeteer from 'puppeteer-core'; // Puppeteer removed

import { scanWebsiteSchema } from './validation/scanWebsiteSchema';

// Define interfaces for strong typing
interface AxeCheck {
  id: string;
  impact?: 'minor' | 'moderate' | 'serious' | 'critical';
  message: string;
  data?: unknown; // Changed from any to unknown
  relatedNodes?: AxeRelatedNode[];
}

interface AxeRelatedNode {
  target: string[];
  html: string;
}

interface AxeNode {
  html: string;
  target: string[];
  failureSummary?: string;
  any?: AxeCheck[];
  all?: AxeCheck[];
}

interface AxeViolation {
  id: string;
  description: string;
  help: string;
  helpUrl: string;
  impact?: 'minor' | 'moderate' | 'serious' | 'critical';
  tags?: string[];
  nodes?: AxeNode[];
}

interface ScanResultFromDB {
  id?: number | string;
  job_id?: string;
  original_job_id?: string;
  submitted_url: string;
  actual_url?: string;
  scan_timestamp?: string | Date;
  page_title?: string;
  scan_success?: boolean;
  violations: AxeViolation[];
  error_message?: string;
  page_screenshot?: string;
}

// Define PageHealthStatusReport, as it is used by calculatePageHealthReport
interface PageHealthStatusReport {
  level: string;
  description: string;
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

const app = express();
const port = process.env.PORT || 3000;

// BullMQ Queue setup
const SCAN_QUEUE_NAME = 'scan-jobs';
// Use REDIS_URL if available (from Railway), otherwise fall back to host/port (for local Docker)
const connection = process.env.REDIS_URL
  ? new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
  : {
      host: process.env.REDIS_HOST || 'redis',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    };

const scanQueue = new Queue(SCAN_QUEUE_NAME, {
  connection: connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
});

logger.info(`BullMQ queue '${SCAN_QUEUE_NAME}' initialized.`);

// PostgreSQL Connection Pool
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || 'user',
  password: process.env.POSTGRES_PASSWORD || 'password',
  database: process.env.POSTGRES_DB || 'accessibility_scanner_dev',
});

pool.on('connect', () => {
  logger.info('API Service connected to PostgreSQL database');
});

pool.on('error', (err: Error) => {
  logger.error(
    { error: err.message, stack: err.stack },
    'API Service PostgreSQL pool error',
  );
});

// Define Zod schema for URL submission
const SubmitUrlSchema = z.object({
  url: z.string().url({ message: 'Invalid URL format' }),
});

// Middleware to parse JSON bodies
app.use(express.json());

// Enable CORS for all routes and origins
// For production, you should restrict this to your frontend's actual origin:
// app.use(cors({ origin: 'http://localhost:5173' })); // Replace with your SvelteKit frontend's actual origin
app.use(cors());

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

// New endpoint to get scan results by Job ID
app.get('/api/scan-results/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params;

  if (!jobId) {
    return res.status(400).send({ message: 'Job ID is required' });
  }

  try {
    logger.info({ jobId }, 'Fetching scan result for Job ID');
    const query =
      'SELECT * FROM scan_results WHERE job_id = $1 OR original_job_id = $1';
    const { rows } = await pool.query(query, [jobId]);

    if (rows.length === 0) {
      logger.warn({ jobId }, 'Scan result not found for Job ID');
      return res.status(404).send({ message: 'Scan result not found' });
    }

    const result: ScanResultFromDB = rows[0] as ScanResultFromDB;
    if (result.violations && typeof result.violations === 'string') {
      try {
        // Attempt to parse if it's a string, but expect it to be AxeViolation[]
        result.violations = JSON.parse(
          result.violations as unknown as string,
        ) as AxeViolation[];
      } catch (parseError) {
        logger.warn(
          { jobId, error: parseError },
          'Failed to parse violations JSON string from DB',
        );
      }
    }

    logger.info(
      { jobId, resultId: result.id },
      'Scan result retrieved successfully',
    );
    res.status(200).send(result);
  } catch (error) {
    let errorMessage = 'Failed to fetch scan result';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    logger.error(
      {
        jobId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Error fetching scan result from database',
    );
    res
      .status(500)
      .send({ message: 'Internal server error while fetching scan result' });
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

// Helper functions (to be added in accessibility-scanner-backend/apps/api/src/index.ts)

function calculateAccessibilityScoreReport(
  axeViolations: AxeViolation[],
): number {
  let score = 100;
  (axeViolations || []).forEach((violation) => {
    const numFails = violation.nodes?.length || 0;
    switch (violation.impact) {
      case 'critical':
        score -= numFails * 10;
        break;
      case 'serious':
        score -= numFails * 5;
        break;
      case 'moderate':
        score -= numFails * 2;
        break;
      case 'minor':
        score -= numFails * 1;
        break;
      default:
        score -= numFails * 1;
    }
  });
  return Math.max(0, Math.min(100, Math.round(score)));
}

function calculatePageHealthReport(
  violations: AxeViolation[] | undefined,
  score: number,
): PageHealthStatusReport {
  const v = violations || [];
  if (v.some((item) => item.impact === 'critical')) {
    return {
      level: 'Critical Issues',
      description:
        'Critical accessibility barriers found that severely impact usability. Urgent attention required.',
    };
  }
  if (v.some((item) => item.impact === 'serious')) {
    return {
      level: 'Serious Concerns',
      description:
        'Serious accessibility issues identified. These likely create significant barriers for some users.',
    };
  }
  if (score < 85 || v.some((item) => item.impact === 'moderate')) {
    return {
      level: 'Needs Improvement',
      description:
        'Moderate or multiple minor issues found. Site is usable but could be improved for better accessibility.',
    };
  }
  return {
    level: 'Good Shape',
    description:
      'Looking good! Only minor or no significant accessibility issues detected by automated checks.',
  };
}

function formatTimestampReport(timestamp: string | Date | undefined): string {
  if (!timestamp) return 'N/A';
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    // Removed '_error' as it's unused
    // Attempt to provide a more consistent string representation if it's already a string
    return typeof timestamp === 'string' ? timestamp : String(timestamp);
  }
}

// Function to generate HTML for the PDF report
function generateReportHtml(dbResult: ScanResultFromDB): string {
  // Escape HTML characters
  const escapeHtml = (unsafe: string | undefined | null): string => {
    if (unsafe === null || typeof unsafe === 'undefined') return '';
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  // Prepare UI data based on dbResult
  const axeViolations = dbResult.violations || [];
  const accessibilityScore = calculateAccessibilityScoreReport(axeViolations);
  const pageHealthStatus = calculatePageHealthReport(
    axeViolations,
    accessibilityScore,
  );
  const totalViolations = axeViolations.reduce(
    (sum: number, v: AxeViolation) => sum + (v.nodes?.length || 0),
    0,
  );
  const pageScreenshotBase64 = dbResult.page_screenshot;

  const violationsHtml =
    axeViolations && axeViolations.length > 0
      ? axeViolations
          .map(
            (violation: AxeViolation) => `
      <div class="violation-item impact-${violation.impact || 'unknown'}">
        <h3>${escapeHtml(violation.id)}</h3>
        <div class="violation-meta">
          <span class="impact">Impact: ${escapeHtml(violation.impact || 'N/A')}</span>
          ${violation.tags && violation.tags.length > 0 ? `<span class="tags">Tags: ${escapeHtml(violation.tags.join(', '))}</span>` : ''}
        </div>
        <p class="description">${escapeHtml(violation.description)}</p>
        <p class="help"><a href="${escapeHtml(violation.helpUrl)}" target="_blank" rel="noopener noreferrer">Learn more: ${escapeHtml(violation.help)}</a></p>

        ${
          violation.nodes && violation.nodes.length > 0
            ? `
          <h4>Affected Elements (${violation.nodes.length}):</h4>
          <ul class="nodes-list">
            ${violation.nodes
              .map(
                (node: AxeNode, index: number) => `
              <li class="node-item">
                <p class="node-heading"><strong>Element ${index + 1}</strong></p>
                ${node.target && node.target.length > 0 ? `<p class="target-selector"><strong>Selector:</strong> <code>${escapeHtml(node.target.join(', '))}</code></p>` : ''}
                <p class="html-snippet-label"><strong>HTML Snippet:</strong></p>
                <pre class="html-snippet"><code>${escapeHtml(node.html)}</code></pre>
                ${
                  node.failureSummary
                    ? `
                  <div class="failure-summary">
                     <p><strong>Failure Summary:</strong></p>
                     <p>${escapeHtml(
                       node.failureSummary
                         .replace(/^Fix all of the following:/, '')
                         .replace(/^Fix any of the following:/, '')
                         .trim(),
                     )}</p>
                  </div>`
                    : ''
                }
                ${
                  (node.any && node.any.length > 0) ||
                  (node.all && node.all.length > 0)
                    ? `
                  <div class="specific-checks">
                    <p><strong>Specific Checks:</strong></p>
                    <ul>
                      ${[...(node.any || []), ...(node.all || [])]
                        .map(
                          (check: AxeCheck) => `
                        <li>
                          <p><strong>${escapeHtml(check.id)} (${escapeHtml(check.impact || 'N/A')}):</strong> ${escapeHtml(check.message)}</p>
                          ${check.data ? `<p class="check-data">Data: ${escapeHtml(JSON.stringify(check.data))}</p>` : ''}
                        </li>
                      `,
                        )
                        .join('')}
                    </ul>
                  </div>`
                    : ''
                }
              </li>
            `,
              )
              .join('')}
          </ul>
        `
            : ''
        }
      </div>
    `,
          )
          .join('')
      : '<p>No violations found, or data is not available for detailed violations.</p>';

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Accessibility Scan Report</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        h1, h2, h3, h4 { color: #333; }
        .violation-item { border: 1px solid #ccc; padding: 10px; margin-bottom: 10px; page-break-inside: avoid; }
        .impact-critical { border-left: 5px solid red; }
        .impact-serious { border-left: 5px solid orange; }
        .impact-moderate { border-left: 5px solid gold; }
        .impact-minor { border-left: 5px solid lightblue; }
        .html-snippet { background-color: #f0f0f0; padding: 5px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
        /* Most styles commented out for debugging PDF corruption */
        /*
        body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; margin: 0; padding: 0; }
        .scan-report-pdf { width: 100%; max-width: 210mm; margin: 0 auto; padding: 15mm; box-sizing: border-box; }
        header h1 { font-size: 28px; color: #1a237e; margin-bottom: 10px; text-align: center; border-bottom: 2px solid #3949ab; padding-bottom: 10px; }
        .meta-info { font-size: 12px; margin-bottom: 20px; text-align: center; }
        .meta-info p { margin: 2px 0; }
        .summary-section h2, .violations-section h2 { font-size: 20px; color: #283593; margin-top: 30px; margin-bottom: 15px; border-bottom: 1px solid #c5cae9; padding-bottom: 5px; }
        .summary-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-bottom: 20px; padding: 15px; background-color: #f3f4f6; border-radius: 8px; }
        .summary-grid > div { text-align: center; padding: 10px; box-sizing: border-box; }
        .summary-grid .label { font-size: 12px; font-weight: bold; color: #555; margin-bottom: 5px; }
        .summary-grid .value { font-size: 24px; font-weight: bold; }
        .summary-grid .description { font-size: 11px; color: #666; }
        .score-low, .health-critical-issues { color: #d32f2f; }
        .score-medium, .health-serious-concerns { color: #f57c00; }
        .health-needs-improvement { color: #fbc02d; }
        .score-high, .health-good-shape { color: #388e3c; }
        .violation-item { margin-bottom: 20px; padding: 15px; border: 1px solid #e0e0e0; border-radius: 6px; background-color: #fff; page-break-inside: avoid; }
        .violation-item h3 { font-size: 16px; color: #3f51b5; margin-top: 0; margin-bottom: 8px; word-break: break-all; }
        .violation-meta { font-size: 11px; margin-bottom: 8px; color: #424242; }
        .violation-meta .impact { font-weight: bold; padding: 2px 6px; border-radius: 4px; color: white; display: inline-block; margin-right: 5px; }
        .impact-critical { background-color: #c62828; }
        .impact-serious { background-color: #ef6c00; }
        .impact-moderate { background-color: #f9a825; }
        .impact-minor { background-color: #1565c0; }
        .impact-unknown { background-color: #616161; }
        .violation-meta .tags { font-style: italic; }
        .violation-item .description { font-size: 13px; margin-bottom: 8px; }
        .violation-item .help a { font-size: 12px; color: #1976d2; text-decoration: none; word-break: break-all; }
        .violation-item .help a:hover { text-decoration: underline; }
        .violation-item h4 { font-size: 14px; color: #455a64; margin-top: 15px; margin-bottom: 5px; }
        .nodes-list { list-style-type: none; padding-left: 0; }
        .node-item { background-color: #fafafa; padding: 10px; margin-bottom: 10px; border-radius: 4px; border: 1px solid #eeeeee; font-size: 12px; }
        .node-heading { margin-top: 0; margin-bottom: 5px; }
        .target-selector { margin-bottom: 5px; }
        .target-selector code { background-color: #e8eaf6; padding: 2px 4px; border-radius: 3px; font-family: 'Courier New', Courier, monospace; word-break: break-all; }
        .html-snippet-label { margin-bottom: 3px; }
        .html-snippet { background-color: #263238; color: #eceff1; padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 11px; white-space: pre-wrap; word-break: break-all; }
        .failure-summary { background-color: #ffebee; border: 1px solid #ffcdd2; padding: 8px; margin-top: 8px; margin-bottom: 8px; border-radius: 4px; font-size: 12px; }
        .failure-summary p { margin: 3px 0; }
        .specific-checks { margin-top: 8px; }
        .specific-checks ul { list-style-type: disc; padding-left: 20px; font-size: 11px; }
        .specific-checks li { margin-bottom: 4px; }
        .check-data { font-style: italic; color: #757575; padding-left: 10px; font-size: 10px; word-break: break-all; }
        footer { margin-top: 40px; text-align: center; font-size: 10px; color: #777; border-top: 1px solid #e0e0e0; padding-top: 10px; }
        */
      </style>
    </head>
    <body>
      <div class="scan-report-pdf">
        <header>
          <h1>Accessibility Scan Report</h1>
          <div class="meta-info">
            <p><strong>Scanned URL:</strong> ${escapeHtml(dbResult?.actual_url || dbResult?.submitted_url)}</p>
            <p><strong>Page Title:</strong> ${escapeHtml(dbResult?.page_title)}</p>
            <p><strong>Scan Date:</strong> ${escapeHtml(formatTimestampReport(dbResult?.scan_timestamp))}</p>
          </div>
        </header>
        <section class="summary-section">
          <h2>Scan Summary</h2>
          <div class="summary-grid">
            <div>
              <p class="label">Accessibility Score</p>
              <p class="value score-${accessibilityScore < 50 ? 'low' : accessibilityScore < 75 ? 'medium' : 'high'}">
                ${accessibilityScore}%
              </p>
            </div>
            <div>
              <p class="label">Page Health</p>
              <p class="value health-${pageHealthStatus?.level.toLowerCase().replace(/\s+/g, '-') || 'unknown'}">
                ${escapeHtml(pageHealthStatus?.level)}
              </p>
              <p class="description">${escapeHtml(pageHealthStatus?.description)}</p>
            </div>
            <div>
              <p class="label">Total Violations Found</p>
              <p class="value">${totalViolations}</p>
            </div>
          </div>
        </section>
        ${
          pageScreenshotBase64
            ? `
        <section class="screenshot-section">
          <h2>Page Screenshot</h2>
          <img src="data:image/jpeg;base64,${pageScreenshotBase64}" alt="Screenshot of the scanned page" style="width: 100%; max-width: 600px; height: auto; border: 1px solid #ccc; margin-top: 10px;" />
        </section>
        `
            : ''
        }
        <section class="violations-section">
          <h2>Detailed Violations</h2>
          ${violationsHtml}
        </section>
        <footer>
          <p>Report generated by Digital Accessibility Centre Scan Tool &copy; ${new Date().getFullYear()}</p>
        </footer>
      </div>
    </body>
    </html>
  `;
}

// API Endpoint for HTML Export (previously PDF Export)
app.get('/api/export-report/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  logger.info(
    { jobId },
    'Received request to export report as HTML for Job ID',
  );

  if (!jobId) {
    return res.status(400).send({ message: 'Job ID is required' });
  }

  try {
    const query =
      'SELECT * FROM scan_results WHERE job_id = $1 OR original_job_id = $1';
    const { rows } = await pool.query(query, [jobId]);

    if (rows.length === 0) {
      logger.warn(
        { jobId },
        'Scan result not found for Job ID for HTML export',
      );
      return res.status(404).send({ message: 'Scan result not found' });
    }

    const dbResult: ScanResultFromDB = rows[0] as ScanResultFromDB;

    // Ensure violations is an object/array
    if (dbResult.violations && typeof dbResult.violations === 'string') {
      try {
        // Attempt to parse if it's a string, but expect it to be AxeViolation[]
        dbResult.violations = JSON.parse(
          dbResult.violations as unknown as string,
        ) as AxeViolation[];
      } catch (parseError) {
        logger.error(
          { jobId, error: parseError },
          'Failed to parse violations JSON for HTML export',
        );
        dbResult.violations = []; // Set to empty array to prevent further errors
      }
    } else if (!dbResult.violations) {
      dbResult.violations = []; // Ensure it's an array if null/undefined
    }

    if (!dbResult.scan_success) {
      logger.warn(
        { jobId },
        'Scan was not successful or is still in progress. HTML report might be incomplete or erroneous.',
      );
    }

    logger.info({ jobId }, 'Generating HTML for report');
    const htmlContent = generateReportHtml(dbResult);

    // Log the generated HTML (or a snippet if it's too long)
    if (htmlContent.length < 2000) {
      // Log short HTMLs fully
      logger.info({ jobId, htmlContent }, 'Generated HTML content for report');
    } else {
      logger.info(
        {
          jobId,
          htmlSnippet:
            htmlContent.substring(0, 500) +
            '...' +
            htmlContent.substring(htmlContent.length - 500),
          htmlLength: htmlContent.length,
        },
        'Generated HTML content for report (snippet)',
      );
    }
    // For more thorough debugging, you could write htmlContent to a temporary file:
    // fs.writeFileSync(`/tmp/report-${jobId}.html`, htmlContent);
    // logger.info({ jobId }, `HTML content saved to /tmp/report-${jobId}.html`);

    res.setHeader('Content-Type', 'text/html');
    res.send(htmlContent);
    logger.info({ jobId }, 'HTML report sent successfully');
  } catch (error) {
    let errorMessage = 'Failed to generate HTML report';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    logger.error(
      {
        jobId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Error generating HTML report',
    );
    res
      .status(500)
      .send({ message: 'Internal server error while generating HTML report' });
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

  // Close PostgreSQL pool
  try {
    await pool.end();
    logger.info('API Service PostgreSQL pool closed.');
  } catch (err) {
    logger.error({ err }, 'Error closing API Service PostgreSQL pool.');
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
