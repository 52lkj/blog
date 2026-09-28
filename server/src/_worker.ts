import { drizzle } from "drizzle-orm/d1";
import { createApp, createDefaultApp } from "./server";
import { CacheImpl } from "./utils/cache";

export function getServicePath(path: string): string | null {
    if (path.startsWith('/api/')) {
        return path.slice(4);
    }

    // GitHub OAuth applications may still use the callback URL documented
    // before the frontend and Worker were split into separate deployments.
    if (path === '/user/github/callback') {
        return path;
    }

    return null;
}

export default {
    async fetch(
        request: Request,
        env: Env,
    ): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;

        // Handle RSS feeds directly (native RSS support at root path)
        // Matches: /rss.xml, /atom.xml, /rss.json, /feed.json, /feed.xml
        if (path.match(/^\/(rss\.xml|atom\.xml|rss\.json|feed\.json|feed\.xml)$/)) {
            const app = await createApp(env, path);
            if (app) {
                return await app.handle(request, env);
            }
            return new Response('RSS Feed Not Found', { status: 404 });
        }

        // Route API requests and the legacy GitHub OAuth callback to services.
        const servicePath = getServicePath(path);
        if (servicePath) {
            const app = await createApp(env, servicePath);
            if (app) {
                const modifiedUrl = new URL(servicePath + url.search, url.origin);
                const modifiedRequest = new Request(modifiedUrl, request);
                return await app.handle(modifiedRequest, env);
            }
            // API path not found, return 404
            return new Response('Not Found', { status: 404 });
        }

        // Serve static assets (for files with extensions)
        if (path.match(/\.\w+$/) && env.ASSETS) {
            try {
                const asset = await env.ASSETS.fetch(request);
                // Accept 200 OK and 3xx redirects
                if (asset && (asset.status === 200 || (asset.status >= 300 && asset.status < 400))) {
                    return asset;
                }
            } catch (e) {
                // Asset not found, continue to serve index.html
            }
        }

        // For all other routes (SPA), serve index.html
        if (env.ASSETS) {
            try {
                const indexRequest = new Request(new URL('/', url.origin), request);
                const indexResponse = await env.ASSETS.fetch(indexRequest);
                // Accept 200 OK and 3xx redirects
                if (indexResponse && (indexResponse.status === 200 || (indexResponse.status >= 300 && indexResponse.status < 400))) {
                    return indexResponse;
                }
            } catch (e) {
                // index.html not found
            }
        }

        // Fallback to default app
        const defaultApp = createDefaultApp(env);
        return await defaultApp.handle(request, env);
    },

    async scheduled(
        _controller: ScheduledController | null,
        env: Env,
        ctx: ExecutionContext
    ) {
        const schema = await import('./db/schema');
        const db = drizzle(env.DB, { schema: schema });

        // Create cache instances
        const cache = new CacheImpl(db, env, "cache");
        const serverConfig = new CacheImpl(db, env, "server.config");
        const clientConfig = new CacheImpl(db, env, "client.config");

        // Import and run crontab functions
        const { friendCrontab } = await import('./services/friends');
        const { rssCrontab } = await import('./services/rss');

        await friendCrontab(env, ctx, db, cache, serverConfig, clientConfig)
        await rssCrontab(env, db)
    },
}
