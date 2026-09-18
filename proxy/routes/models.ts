import type { Request, Response } from 'express';
import { getClient } from '../client.ts';
import { logger } from '../logger.ts';

async function handleModels(_req: Request, res: Response): Promise<void> {
    try {
        const client = getClient();
        const { providers, models } = await client.getProvidersAndModels();

        // Build a lookup of provider settings
        const providerSettings = new Map<string, Record<string, unknown>>();
        for (const p of providers) {
            providerSettings.set(p.id, p.settings || {});
        }

        const modelsList: Array<{
            id: string;
            name: string;
            object: string;
            created: number;
            owned_by?: string;
        }> = [];
        for (const m of models) {
            modelsList.push({
                id: `${m.providerID}/${m.id}`,
                name: m.name || m.id,
                object: 'model',
                created: 1704067200,
                owned_by: m.providerID
            });
        }
        res.json({ object: 'list', data: modelsList });
    } catch (error) {
        logger.error('Error fetching models:', error);
        res.status(500).json({ error: { message: 'Failed to fetch models from OpenCode' } });
    }
}

export { handleModels };
