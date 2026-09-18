import express from 'express';
import cors from 'cors';
import { requestIdMiddleware } from './middleware.ts';
import { authMiddleware } from './auth.ts';
import { handleModels } from './routes/models.ts';
import { chatCompletionsHandler } from './routes/chat.ts';
import { responsesHandler } from './routes/responses.ts';

const MAX_BODY_BYTES = 1024 * 1024 * (parseInt(process.env.MAX_BODY_MB || '5', 10) || 5);

const app = express();

app.use(cors());
app.use(express.json({ limit: MAX_BODY_BYTES }));
app.use(express.urlencoded({ limit: MAX_BODY_BYTES, extended: true }));
app.use(requestIdMiddleware);
app.use(authMiddleware);

app.get('/v1/models', handleModels);
app.post('/v1/chat/completions', chatCompletionsHandler);
app.post('/v1/responses', responsesHandler);

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', proxy: true });
});

export default app;

// Re-export state helpers for tests or external use if needed
export { storeResponseState, getResponseState } from './state.ts';
