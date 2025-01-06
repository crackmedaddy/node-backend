// src/app.ts
// noinspection TypeScriptValidateTypes

import dotenv from 'dotenv';
dotenv.config();

import express, { Application } from 'express';
import cors from 'cors';

import vaultRoutes from './routes/vaultRoutes';
import { handleStreamData } from './chat/chatHandlers';

const app: Application = express();
app.use(cors());
app.use(express.json());

/**
 * Example of a custom CORS middleware if you need to replicate
 * your old server.ts logic. Adjust allowedOrigins as needed.
 */
const allowedOrigins: string[] = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://dev.crackmedaddy.com',
    'https://crackmedaddy.com',
    'https://www.crackmedaddy.com'
];

app.use((req: any, res: any, next: any) => {
    const origin = req.headers.origin || '';
    console.log('origin', origin);
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

/**
 * Mount the "stream chat" route from chatHandlers.
 * We define the route path here, but the actual handler
 * logic is in `handleStreamData`.
 */
app.post('/challenges/:challenge_id/conversations/:conversation_id/stream-data', handleStreamData);

/**
 * Mount additional routes, e.g. the vault routes
 */
app.use('/api/vault', vaultRoutes);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});



/**
 * Add a health check endpoint
 */
app.get('/', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});
