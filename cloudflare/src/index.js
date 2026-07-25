// index.js — Cloudflare Workers entry point
// Routes all requests to the single Durable Object instance.

import { RssChatDO } from './rsschat-do.js';

export { RssChatDO };

export default {
    async fetch(request, env, ctx) {
        const doId = env.RSSCHAT_DO.idFromName("default");
        const stub = env.RSSCHAT_DO.get(doId);
        return stub.fetch(request);
    }
};
