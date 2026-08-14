import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import express from 'express';
import type { ModuleLogger } from '../../services/logger';

interface ResourceRouteOptions {
    app: Express;
    bundleRoot: string;
    logger: ModuleLogger;
    webDist: string;
}

function registerStaticResourceRoutes(options: ResourceRouteOptions): void {
    const { app, bundleRoot, logger, webDist } = options;
    if (fs.existsSync(webDist)) {
        app.use(express.static(webDist));
    } else {
        logger.warn('web build not found', { webDist });
        app.get('/', (_req, res) => res.send('web build not found. Please build the web project.'));
    }

    app.use('/game-assets', express.static(path.join(bundleRoot, 'assets'), {
        immutable: true,
        maxAge: '1y',
        setHeaders(res, filePath) {
            const contentHash = path.basename(filePath).split('.')[0];
            res.setHeader('ETag', `"${contentHash}"`);
            res.setHeader('X-Content-Type-Options', 'nosniff');
        },
    }));
    app.use('/game-config', (_req, res) => res.sendStatus(404));
}

function registerSpaFallback(options: Pick<ResourceRouteOptions, 'app' | 'webDist'>): void {
    const { app, webDist } = options;
    app.get('*', (req, res) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-assets')) {
            return res.status(404).json({ ok: false, error: 'Not Found' });
        }
        if (fs.existsSync(webDist)) {
            return res.sendFile(path.join(webDist, 'index.html'));
        }
        return res.status(404).send('web build not found. Please build the web project.');
    });
}

export { registerSpaFallback, registerStaticResourceRoutes };
