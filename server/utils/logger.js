// server/utils/logger.js

const util = require('util');

const LOG_LEVEL = process.env.LOG_LEVEL || 'production';

const colors = {
    reset: "\x1b[0m",
    fg: {
        red: "\x1b[31m",
        green: "\x1b[32m",
        yellow: "\x1b[33m",
        blue: "\x1b[34m",
        magenta: "\x1b[35m",
        cyan: "\x1b[36m",
        gray: "\x1b[90m"
    }
};

const formatTime = () => {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
};

const padModule = (module) => {
    return String(module).padEnd(10).substring(0, 10).toUpperCase();
};

const formatMessage = (message) => {
    if (typeof message === 'object') {
        return util.inspect(message, { colors: true, depth: null, compact: true });
    }
    return message;
};

const log = {
    info: (module, message) => {
        console.log(`${formatTime()} | ${colors.fg.cyan}${padModule(module)}${colors.reset} | ${formatMessage(message)}`);
    },
    success: (module, message) => {
        console.log(`${formatTime()} | ${colors.fg.green}${padModule(module)}${colors.reset} | ${formatMessage(message)}`);
    },
    warn: (module, message) => {
        console.log(`${formatTime()} | ${colors.fg.yellow}${padModule(module)}${colors.reset} | ${formatMessage(message)}`);
    },
    error: (module, message, error = null, action = null) => {
        console.log(`${formatTime()} | ${colors.fg.red}${padModule('ERROR')}${colors.reset} | ${formatMessage(message)}`);
        
        if (error) {
            console.log(`${colors.fg.red}CAUSE    | ${formatMessage(error.message || error)}${colors.reset}`);
        }
        
        if (action) {
            console.log(`${colors.fg.yellow}ACTION   | ${action}${colors.reset}`);
        }

        if (LOG_LEVEL === 'debug' && error && error.stack) {
            console.log(`${colors.fg.gray}${error.stack}${colors.reset}`);
        }
    },
    auditLog: (req, action, metadata = {}) => {
        const userId = req.user ? req.user._id : 'anonymous';
        const ip = req.ip || req.connection.remoteAddress;
        console.log(`${formatTime()} | ${colors.fg.magenta}${padModule('AUDIT')}${colors.reset} | [${userId}] ${action} | IP: ${ip} | Data: ${JSON.stringify(metadata)}`);
    }
};

/**
 * auditLog - logs an audit event with request context.
 * Usage: auditLog(req, 'EVENT_NAME', { ...details })
 */
const auditLog = (req, event, details = {}) => {
    const user = req?.user?.email || req?.user?._id || 'unknown';
    const ip = req?.ip || req?.connection?.remoteAddress || 'unknown';
    console.log(`${formatTime()} | ${colors.fg.magenta}${padModule('AUDIT')}${colors.reset} | ${event} | user=${user} ip=${ip} ${JSON.stringify(details)}`);
};

log.auditLog = auditLog;

module.exports = log;
module.exports.auditLog = auditLog;
