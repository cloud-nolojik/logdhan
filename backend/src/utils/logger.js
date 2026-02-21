import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

/**
 * Winston format configuration
 */
const customFormat = printf(({ level, message, timestamp, ...metadata }) => {
    let msg = `[${timestamp}] ${level}: ${message}`;
    if (Object.keys(metadata).length > 0) {
        msg += ` ${JSON.stringify(metadata)}`;
    }
    return msg;
});

/**
 * Application structured logger
 */
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        process.env.NODE_ENV !== 'production' ? colorize() : winston.format.uncolorize(),
        customFormat
    ),
    transports: [
        new winston.transports.Console()
    ],
});

export default logger;
