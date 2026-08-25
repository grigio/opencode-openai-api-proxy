import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger, runWithRequestId } from './logger.ts';

function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
    const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    // expose on request for downstream handlers
    (req as unknown as Record<string, unknown>).requestId = requestId;
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        // log inside the request context so JSON logs carry requestId
        runWithRequestId(requestId, () => {
            logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
        });
    });
    runWithRequestId(requestId, () => next());
}

export { requestIdMiddleware };
