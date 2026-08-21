import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

const errorHandler = (err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    const message = err.message || 'Server Error';
    const requestId = req.requestId || '-';

    logger.error(
        `[${requestId}] ${req.method} ${req.originalUrl} ${statusCode} - ${err.name || 'Error'} - ${message}`
    );

    // 5xx stacks are logged in EVERY environment. They used to be development-only,
    // which is backwards: production is where you cannot reproduce the failure and
    // the stack is the only way to find it. 4xx are deliberate and need no stack.
    if (err.stack && (statusCode >= 500 || config.nodeEnv === 'development')) {
        logger.error(`[${requestId}] ${err.stack}`);
    }

    // A 4xx message is written by us for the caller ("Order not found"), so it is safe
    // to return. A 5xx message is whatever threw — a Mongoose CastError, a driver
    // failure, sometimes a connection string — and was previously sent verbatim to the
    // client. Anything not explicitly given a statusCode falls here and is masked.
    //
    // Development keeps the real text, or debugging every 500 means tailing the log.
    const isClientError = statusCode >= 400 && statusCode < 500;
    const publicMessage = isClientError || config.nodeEnv === 'development'
        ? message
        : 'Internal server error';

    res.status(statusCode).json({
        success: false,
        error: publicMessage,
        // Lets a user quote an id that points at the real message in the logs. Without
        // it, masking a 5xx leaves support with nothing to correlate against.
        requestId
    });
};

export default errorHandler;
