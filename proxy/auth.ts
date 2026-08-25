import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.ts';

function authMiddleware(req: Request, res: Response, next: NextFunction): Response | void {
    if (req.path === '/health') return next();

    const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;

    if (!serverPassword) {
        logger.error(
            'OPENCODE_SERVER_PASSWORD is not set. Refusing to start serving requests without authentication.'
        );
        return res.status(503).json({
            error: {
                message:
                    'Server authentication is not configured. Set OPENCODE_SERVER_PASSWORD and restart the proxy.'
            }
        });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: {
                message:
                    'Missing or invalid Authorization header. Expected Bearer <OPENCODE_SERVER_PASSWORD>'
            }
        });
    }

    const token = authHeader.split(' ')[1]!;
    const expected = Buffer.from(serverPassword);
    const supplied = Buffer.from(token);
    const valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

    if (!valid) {
        return res.status(401).json({ error: { message: 'Invalid API key' } });
    }
    return next();
}

export { authMiddleware };
