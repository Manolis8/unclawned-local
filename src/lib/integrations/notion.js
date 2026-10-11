import { getAndRefreshToken, makeApiCall } from '../api-caller.js';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_API_VERSION = '2022-06-28';
export async function listDatabases(userId) {
    const token = await getAndRefreshToken(userId, 'notion');
    if (!token)
        throw new Error('Notion not connected');
    return makeApiCall(`${NOTION_API_BASE}/search`, {
        method: 'POST',
        authorization: `Bearer ${token.accessToken}`,
        headers: { 'Notion-Version': NOTION_API_VERSION },
        body: { filter: { property: 'object', value: 'database' }, page_size: 10 }
    });
}
export async function createPage(userId, parentId, title, content) {
    const token = await getAndRefreshToken(userId, 'notion');
    if (!token)
        throw new Error('Notion not connected');
    return makeApiCall(`${NOTION_API_BASE}/pages`, {
        method: 'POST',
        authorization: `Bearer ${token.accessToken}`,
        headers: { 'Notion-Version': NOTION_API_VERSION },
        body: {
            parent: { database_id: parentId },
            properties: {
                title: {
                    title: [{ type: 'text', text: { content: title } }]
                }
            },
            children: [
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content } }]
                    }
                }
            ]
        }
    });
}
export async function createPageInParent(userId, parentPageId, title, content) {
    const token = await getAndRefreshToken(userId, 'notion');
    if (!token)
        throw new Error('Notion not connected');
    return makeApiCall(`${NOTION_API_BASE}/pages`, {
        method: 'POST',
        authorization: `Bearer ${token.accessToken}`,
        headers: { 'Notion-Version': NOTION_API_VERSION },
        body: {
            parent: { page_id: parentPageId },
            properties: {
                title: {
                    title: [{ type: 'text', text: { content: title } }]
                }
            },
            children: [
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content } }]
                    }
                }
            ]
        }
    });
}
export async function getPage(userId, pageId) {
    const token = await getAndRefreshToken(userId, 'notion');
    if (!token)
        throw new Error('Notion not connected');
    return makeApiCall(`${NOTION_API_BASE}/pages/${pageId}`, {
        authorization: `Bearer ${token.accessToken}`,
        headers: { 'Notion-Version': NOTION_API_VERSION }
    });
}
export async function appendBlocksToPage(userId, pageId, blocks) {
    const token = await getAndRefreshToken(userId, 'notion');
    if (!token)
        throw new Error('Notion not connected');
    return makeApiCall(`${NOTION_API_BASE}/blocks/${pageId}/children`, {
        method: 'PATCH',
        authorization: `Bearer ${token.accessToken}`,
        headers: { 'Notion-Version': NOTION_API_VERSION },
        body: { children: blocks }
    });
}
export async function queryDatabase(userId, databaseId) {
    const token = await getAndRefreshToken(userId, 'notion');
    if (!token)
        throw new Error('Notion not connected');
    return makeApiCall(`${NOTION_API_BASE}/databases/${databaseId}/query`, {
        method: 'POST',
        authorization: `Bearer ${token.accessToken}`,
        headers: { 'Notion-Version': NOTION_API_VERSION },
        body: { page_size: 10 }
    });
}
