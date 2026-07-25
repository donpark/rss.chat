// import.js — Bulk import from Node.js export JSON into D1 + R2
// Usage: curl -X POST -d @backup.json https://myserver.chat/admin/import

import { D1DataAccess } from './d1-data-access.js';

export async function importFromNodeExport(env, jstruct) {
    // Import all relational data into D1
    const config = {};
    const dataAccess = new D1DataAccess(env.DB, config, null);
    await dataAccess.importAll(jstruct);

    // Upload media blobs to R2
    if (jstruct.media) {
        for (const media of jstruct.media) {
            if (media.mediabytes) {
                const bytes = typeof media.mediabytes === "string"
                    ? Buffer.from(media.mediabytes, "base64")
                    : media.mediabytes;
                await env.MEDIA_BUCKET.put(
                    media.r2Key || `media/${media.id}`,
                    bytes
                );
            }
        }
    }

    return {
        users: (jstruct.users || []).length,
        items: (jstruct.items || []).length,
        likes: (jstruct.likes || []).length,
        files: (jstruct.files || []).length,
        media: (jstruct.media || []).length
    };
}
