import type { Request, Response } from 'express';
import { getClient } from '../client.ts';
import type { ProviderLike, ProviderModelLike } from '../types.ts';
import { logger } from '../logger.ts';

async function handleModels(_req: Request, res: Response): Promise<void> {
    try {
        const client = getClient();
        const providersRes = await client.config.providers();
        const providersRaw = (providersRes.data?.providers || []) as unknown as
            Record<string, ProviderLike> | ProviderLike[];
        const models: Array<{
            id: string;
            name: string;
            object: string;
            created: number;
            owned_by?: string;
        }> = [];
        const providersList = Array.isArray(providersRaw)
            ? providersRaw
            : Object.entries(providersRaw).map(([id, info]) => ({ ...(info as ProviderLike), id }));
        providersList.forEach((providerInfo) => {
            const providerId = providerInfo.id;
            if (providerInfo.models) {
                Object.entries(providerInfo.models).forEach(([modelId, modelData]) => {
                    const md = modelData as ProviderModelLike | null;
                    models.push({
                        id: `${providerId}/${modelId}`,
                        name:
                            typeof md === 'object' && md ? md.name || md.label || modelId : modelId,
                        object: 'model',
                        created:
                            md && (md as ProviderModelLike).release_date
                                ? Math.floor(
                                      new Date((md as ProviderModelLike).release_date!).getTime() /
                                          1000
                                  )
                                : 1704067200,
                        owned_by: providerId
                    });
                });
            }
        });
        res.json({ object: 'list', data: models });
    } catch (error) {
        logger.error('Error fetching models:', error);
        res.status(500).json({ error: { message: 'Failed to fetch models from OpenCode' } });
    }
}

export { handleModels };
