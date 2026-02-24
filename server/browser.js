// server/browser.js
// Browser automation module: navigate, screenshot, click, type, extract, analyze.
// Supports visual analysis of websites, images, and live browser interaction.
// Uses Puppeteer for headless/headed browser control.

const puppeteer = require('puppeteer');
const TurndownService = require('turndown');
const path = require('path');
const fs = require('fs');

const turndownService = new TurndownService();

const LAUNCH_OPTIONS = {
    headless: 'new',
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
    ],
    defaultViewport: { width: 1280, height: 900 }
};

// Persistent browser session for multi-step interactions
let activeBrowser = null;
let activePage = null;
let screenshotCounter = 0;

function getScreenshotDir(workspaceRoot) {
    const dir = path.join(workspaceRoot || process.cwd(), '.isocode', 'screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function ensureBrowser() {
    if (activeBrowser && activeBrowser.isConnected()) {
        if (!activePage || activePage.isClosed()) {
            activePage = await activeBrowser.newPage();
        }
        return { browser: activeBrowser, page: activePage };
    }
    activeBrowser = await puppeteer.launch(LAUNCH_OPTIONS);
    activePage = await activeBrowser.newPage();
    await activePage.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    return { browser: activeBrowser, page: activePage };
}

async function closeBrowser() {
    try {
        if (activeBrowser) {
            await activeBrowser.close();
            activeBrowser = null;
            activePage = null;
        }
    } catch { }
}

// ---------------------------------------------------------------------------
// read_url — fetch a URL, return content as markdown
// ---------------------------------------------------------------------------

async function read_url({ url }) {
    let browser;
    try {
        browser = await puppeteer.launch(LAUNCH_OPTIONS);
        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0'
        );
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        const content = await page.content();
        const title = await page.title();
        const markdown = turndownService.turndown(content);
        return { title, url, content: markdown.slice(0, 8000) };
    } catch (error) {
        return { error: `Failed to read ${url}: ${error.message}` };
    } finally {
        if (browser) await browser.close();
    }
}

// ---------------------------------------------------------------------------
// screenshot_url — take a screenshot of a URL, return base64 + metadata
// ---------------------------------------------------------------------------

async function screenshot_url({ url, fullPage = false }, ctx = {}) {
    let browser;
    try {
        browser = await puppeteer.launch(LAUNCH_OPTIONS);
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        const title = await page.title();
        const screenshotBuffer = await page.screenshot({
            fullPage,
            type: 'png'
        });

        // Save to workspace
        const dir = getScreenshotDir(ctx.workspaceRoot);
        screenshotCounter++;
        const filename = `screenshot_${Date.now()}_${screenshotCounter}.png`;
        const filepath = path.join(dir, filename);
        fs.writeFileSync(filepath, screenshotBuffer);

        const base64 = screenshotBuffer.toString('base64');

        // Also extract text content for non-vision models
        const textContent = await page.evaluate(() => {
            return document.body?.innerText?.slice(0, 3000) || '';
        });

        return {
            ok: true,
            title,
            url,
            screenshotPath: filepath,
            screenshotBase64: base64.slice(0, 500) + '...(truncated for context)',
            textContent: textContent.slice(0, 2000),
            dimensions: { width: 1280, height: 900 },
            fullBase64Length: base64.length
        };
    } catch (error) {
        return { error: `Screenshot failed for ${url}: ${error.message}` };
    } finally {
        if (browser) await browser.close();
    }
}

// ---------------------------------------------------------------------------
// browser_open — open URL in persistent session
// ---------------------------------------------------------------------------

async function browser_open({ url }, ctx = {}) {
    try {
        const { page } = await ensureBrowser();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        const title = await page.title();
        const currentUrl = page.url();
        return { ok: true, title, url: currentUrl, message: `Opened ${url}` };
    } catch (error) {
        return { error: `Failed to open ${url}: ${error.message}` };
    }
}

// ---------------------------------------------------------------------------
// browser_screenshot — take screenshot of current page
// ---------------------------------------------------------------------------

async function browser_screenshot({ selector, fullPage = false }, ctx = {}) {
    try {
        if (!activePage || activePage.isClosed()) {
            return { error: 'No browser page open. Use browser_open first.' };
        }

        let screenshotBuffer;
        if (selector) {
            const el = await activePage.$(selector);
            if (!el) return { error: `Element "${selector}" not found` };
            screenshotBuffer = await el.screenshot({ type: 'png' });
        } else {
            screenshotBuffer = await activePage.screenshot({ fullPage, type: 'png' });
        }

        const dir = getScreenshotDir(ctx.workspaceRoot);
        screenshotCounter++;
        const filename = `screenshot_${Date.now()}_${screenshotCounter}.png`;
        const filepath = path.join(dir, filename);
        fs.writeFileSync(filepath, screenshotBuffer);

        const base64 = screenshotBuffer.toString('base64');
        const title = await activePage.title();

        return {
            ok: true,
            screenshotPath: filepath,
            base64Preview: base64.slice(0, 200) + '...',
            title,
            url: activePage.url(),
            fullBase64Length: base64.length
        };
    } catch (error) {
        return { error: `Screenshot failed: ${error.message}` };
    }
}

// ---------------------------------------------------------------------------
// browser_click — click an element
// ---------------------------------------------------------------------------

async function browser_click({ selector, text }) {
    try {
        if (!activePage || activePage.isClosed()) {
            return { error: 'No browser page open. Use browser_open first.' };
        }

        if (text) {
            // Click by text content
            const clicked = await activePage.evaluate((t) => {
                const els = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')];
                const match = els.find(el => el.textContent?.trim().toLowerCase().includes(t.toLowerCase()));
                if (match) { match.click(); return true; }
                return false;
            }, text);
            if (!clicked) return { error: `No clickable element found with text "${text}"` };
            await activePage.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
            return { ok: true, clicked: `text: ${text}`, url: activePage.url() };
        }

        await activePage.waitForSelector(selector, { timeout: 5000 });
        await activePage.click(selector);
        await activePage.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
        return { ok: true, clicked: selector, url: activePage.url() };
    } catch (error) {
        return { error: `Click failed: ${error.message}` };
    }
}

// ---------------------------------------------------------------------------
// browser_type — type text into an input
// ---------------------------------------------------------------------------

async function browser_type({ selector, text, pressEnter = false }) {
    try {
        if (!activePage || activePage.isClosed()) {
            return { error: 'No browser page open. Use browser_open first.' };
        }
        await activePage.waitForSelector(selector, { timeout: 5000 });
        await activePage.click(selector, { clickCount: 3 }); // Select all
        await activePage.type(selector, text);
        if (pressEnter) {
            await activePage.keyboard.press('Enter');
            await activePage.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
        }
        return { ok: true, typed: text, selector, url: activePage.url() };
    } catch (error) {
        return { error: `Type failed: ${error.message}` };
    }
}

// ---------------------------------------------------------------------------
// browser_extract — extract content from current page
// ---------------------------------------------------------------------------

async function browser_extract({ selector, attribute }) {
    try {
        if (!activePage || activePage.isClosed()) {
            return { error: 'No browser page open. Use browser_open first.' };
        }

        if (selector) {
            const result = await activePage.evaluate((sel, attr) => {
                const els = [...document.querySelectorAll(sel)];
                if (els.length === 0) return null;
                return els.map(el => ({
                    text: el.textContent?.trim().slice(0, 200) || '',
                    tag: el.tagName?.toLowerCase(),
                    ...(attr ? { [attr]: el.getAttribute(attr) } : {}),
                    href: el.href || undefined
                })).slice(0, 20);
            }, selector, attribute);

            if (!result) return { error: `No elements found for "${selector}"` };
            return { ok: true, elements: result, count: result.length };
        }

        // Full page extraction
        const data = await activePage.evaluate(() => {
            const title = document.title;
            const meta = {};
            document.querySelectorAll('meta').forEach(m => {
                const name = m.getAttribute('name') || m.getAttribute('property');
                if (name) meta[name] = m.getAttribute('content');
            });
            const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => ({
                level: h.tagName, text: h.textContent?.trim().slice(0, 100)
            })).slice(0, 15);
            const links = [...document.querySelectorAll('a[href]')].map(a => ({
                text: a.textContent?.trim().slice(0, 60), href: a.href
            })).slice(0, 20);
            const forms = [...document.querySelectorAll('form')].map(f => ({
                action: f.action, method: f.method,
                inputs: [...f.querySelectorAll('input,select,textarea')].map(i => ({
                    type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
                })).slice(0, 10)
            })).slice(0, 5);
            const bodyText = document.body?.innerText?.slice(0, 3000) || '';
            return { title, meta, headings, links, forms, bodyText };
        });

        return { ok: true, ...data, url: activePage.url() };
    } catch (error) {
        return { error: `Extract failed: ${error.message}` };
    }
}

// ---------------------------------------------------------------------------
// browser_evaluate — run JavaScript on the page
// ---------------------------------------------------------------------------

async function browser_evaluate({ code }) {
    try {
        if (!activePage || activePage.isClosed()) {
            return { error: 'No browser page open. Use browser_open first.' };
        }
        const result = await activePage.evaluate(code);
        return { ok: true, result: typeof result === 'object' ? JSON.stringify(result) : String(result) };
    } catch (error) {
        return { error: `Evaluate failed: ${error.message}` };
    }
}

// ---------------------------------------------------------------------------
// browser_wait — wait for selector or timeout
// ---------------------------------------------------------------------------

async function browser_wait({ selector, timeout = 5000 }) {
    try {
        if (!activePage || activePage.isClosed()) {
            return { error: 'No browser page open. Use browser_open first.' };
        }
        if (selector) {
            await activePage.waitForSelector(selector, { timeout });
            return { ok: true, found: selector };
        }
        await new Promise(r => setTimeout(r, Math.min(timeout, 10000)));
        return { ok: true, waited: timeout };
    } catch (error) {
        return { error: `Wait failed: ${error.message}` };
    }
}

// ---------------------------------------------------------------------------
// browser_close — close the persistent browser session
// ---------------------------------------------------------------------------

async function browser_close() {
    await closeBrowser();
    return { ok: true, message: 'Browser session closed' };
}

// ---------------------------------------------------------------------------
// analyze_image — read an image file and return metadata + base64 for vision
// ---------------------------------------------------------------------------

async function analyze_image({ imagePath }, ctx = {}) {
    try {
        const wsRoot = ctx.workspaceRoot || process.cwd();
        const absPath = path.isAbsolute(imagePath) ? imagePath : path.join(wsRoot, imagePath);

        if (!fs.existsSync(absPath)) {
            return { error: `Image not found: ${absPath}` };
        }

        const buffer = fs.readFileSync(absPath);
        const ext = path.extname(absPath).toLowerCase().replace('.', '');
        const mimeType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || 'image/png';
        const base64 = buffer.toString('base64');
        const sizeKB = Math.round(buffer.length / 1024);

        return {
            ok: true,
            path: absPath,
            mimeType,
            sizeKB,
            base64,
            dimensions: 'Use vision model to analyze visual content'
        };
    } catch (error) {
        return { error: `Image analysis failed: ${error.message}` };
    }
}

// ---------------------------------------------------------------------------
// perform_browser_task — multi-step browser automation
// ---------------------------------------------------------------------------

async function perform_browser_task({ url, steps }) {
    const logs = [];
    try {
        const { page } = await ensureBrowser();
        logs.push(`[Nav] Opening ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        logs.push(`[Nav] Loaded: ${await page.title()}`);

        for (const step of (steps || [])) {
            logs.push(`[Step] ${step.action} ${step.selector || step.value || ''}`);
            try {
                switch (step.action) {
                    case 'click':
                        await page.waitForSelector(step.selector, { timeout: 5000 });
                        await page.click(step.selector);
                        break;
                    case 'type':
                        await page.waitForSelector(step.selector, { timeout: 5000 });
                        await page.type(step.selector, step.value || '');
                        break;
                    case 'wait':
                        await new Promise(r => setTimeout(r, Math.min(step.value || 1000, 10000)));
                        break;
                    case 'screenshot': {
                        const dir = getScreenshotDir();
                        screenshotCounter++;
                        const filename = `task_${Date.now()}_${screenshotCounter}.png`;
                        const filepath = path.join(dir, filename);
                        await page.screenshot({ path: filepath });
                        logs.push(`[Screenshot] Saved: ${filepath}`);
                        break;
                    }
                    case 'scroll':
                        await page.evaluate((y) => window.scrollBy(0, y), step.value || 500);
                        break;
                    case 'read': {
                        const content = await page.content();
                        const md = turndownService.turndown(content);
                        return { ok: true, logs, content: md.slice(0, 5000) };
                    }
                    case 'extract': {
                        const result = await page.evaluate((sel) => {
                            if (!sel) return document.body?.innerText?.slice(0, 3000) || '';
                            const el = document.querySelector(sel);
                            return el ? el.textContent?.trim() || '' : '(not found)';
                        }, step.selector);
                        logs.push(`[Extract] ${String(result).slice(0, 200)}`);
                        break;
                    }
                }
            } catch (stepError) {
                logs.push(`[Error] ${stepError.message}`);
            }
        }

        return { ok: true, logs, url: page.url(), title: await page.title() };
    } catch (error) {
        return { error: error.message, logs };
    }
}

module.exports = {
    read_url,
    screenshot_url,
    browser_open,
    browser_screenshot,
    browser_click,
    browser_type,
    browser_extract,
    browser_evaluate,
    browser_wait,
    browser_close,
    analyze_image,
    perform_browser_task,
    closeBrowser
};
