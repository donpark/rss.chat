// r2-media.js — R2 media upload and serve helpers

export async function uploadToR2(env, base64text, prefix = "media") {
    const bytes = Buffer.from(base64text, "base64");
    const r2Key = `${prefix}/${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    await env.MEDIA_BUCKET.put(r2Key, bytes, {
        httpMetadata: { contentType: "application/octet-stream" }
    });
    return { r2Key, bytes, size: bytes.length };
}

export async function serveFromR2(env, r2Key) {
    const object = await env.MEDIA_BUCKET.get(r2Key);
    if (!object) {
        const err = new Error("Media not found: " + r2Key);
        err.code = 404;
        throw err;
    }
    return object;
}
