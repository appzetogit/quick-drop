import 'dotenv/config';
import { Worker, Queue } from 'bullmq';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { getBullMQConnection } from '../connection.js';
import { MAINTENANCE_QUEUE } from '../queue.constants.js';
import { processMaintenanceJob } from '../processors/maintenance.processor.js';

const startMaintenanceWorker = async () => {
    if (!config.bullmqEnabled) {
        logger.info('BullMQ is disabled. Maintenance worker not started.');
        return null;
    }

    const connection = getBullMQConnection();
    if (!connection) {
        logger.error('Maintenance worker: Redis connection unavailable. Exiting.');
        process.exit(1);
    }

    const worker = new Worker(MAINTENANCE_QUEUE, processMaintenanceJob, {
        connection,
        concurrency: 1,
        defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 }
        }
    });

    // Setup repeatable jobs
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection });
    
    // 1. Subscription Expiry Check (Every day at 3 AM)
    await maintenanceQueue.add(
        'SUBSCRIPTION_EXPIRY_CHECK',
        { type: 'SUBSCRIPTION_EXPIRY_CHECK' },
        {
            repeat: { pattern: '0 3 * * *' }, // 3:00 AM daily
            jobId: 'subscription_expiry_job'
        }
    );

    // 2. FSSAI Expiry Check (Every day at 4 AM)
    await maintenanceQueue.add(
        'FSSAI_EXPIRY_CHECK',
        { type: 'FSSAI_EXPIRY_CHECK' },
        {
            repeat: { pattern: '0 4 * * *' }, // 4:00 AM daily
            jobId: 'fssai_expiry_job'
        }
    );

    worker.on('completed', (job) => logger.info(`Maintenance job ${job.id} completed`));
    worker.on('failed', (job, err) => logger.error(`Maintenance job ${job?.id} failed: ${err.message}`));
    worker.on('error', (err) => logger.error(`Maintenance worker error: ${err.message}`));

    logger.info('Maintenance worker started with repeatable jobs (Subscription & FSSAI)');
    return worker;
};

const worker = await startMaintenanceWorker();

if (worker) {
    const shutdown = async () => {
        await worker.close();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
