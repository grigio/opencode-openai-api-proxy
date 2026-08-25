import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.ts';

function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        logger.info(
            `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms ${requestId}`
        );
    });
    next();
}

export { requestIdMiddleware };
