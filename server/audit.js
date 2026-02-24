const fs = require('fs');
const path = require('path');

const AUDIT_FILE = path.join(process.cwd(), '.isocode', 'audit.json');

// Ensure directory exists
if (!fs.existsSync(path.dirname(AUDIT_FILE))) {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
}

function logAction(toolName, input, result, status = 'SUCCESS') {
    const entry = {
        timestamp: new Date().toISOString(),
        tool: toolName,
        input: input,
        status: status,
        result: result ? result.substring(0, 500) : null // Truncate large results
    };

    try {
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
    } catch (e) {
        console.error("Failed to write to audit log:", e);
    }
}

module.exports = { logAction };
