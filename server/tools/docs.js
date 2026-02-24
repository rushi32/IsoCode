const { SERVICE_TO_URL } = require('../config');
const TurndownService = require('turndown');
const turndownService = new TurndownService();

// Configure turndown to strip scripts and styles
turndownService.remove(['script', 'style', 'nav', 'footer', 'iframe']);

async function read_docs({ url }) {
    console.log(`[read_docs] Fetching ${url}`);

    // Check if valid URL
    try {
        new URL(url);
    } catch (e) {
        return "Error: Invalid URL.";
    }

    try {
        const fetch = (await import('node-fetch')).default || global.fetch; // Robust fetch import
        const response = await fetch(url);

        if (!response.ok) {
            return `Error: Failed to fetch ${url} (Status: ${response.status})`;
        }

        const html = await response.text();
        const markdown = turndownService.turndown(html);

        // Limit size to prevent token overflow (~8k chars)
        const truncated = markdown.slice(0, 8000) + (markdown.length > 8000 ? "\n...(truncated)..." : "");

        return `Documentation for ${url}:\n\n${truncated}`;
    } catch (e) {
        return `Error reading docs: ${e.message}`;
    }
}

module.exports = { read_docs };
