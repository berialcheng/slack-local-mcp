/**
 * Simple logging utility for the Slack MCP server
 * Never logs sensitive information like cookies or tokens
 */

import type { LogLevel } from '../types.js';

export class Logger {
  private level: LogLevel;
  private readonly levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(level: LogLevel = 'info') {
    this.level = level;
  }

  /**
   * Set the logging level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.level];
  }

  /**
   * Sanitize sensitive data from objects
   */
  private sanitize(data: unknown): unknown {
    if (typeof data === 'string') {
      return data
        .replace(/\bxox[a-z]-[a-z0-9%._-]+/gi, '[REDACTED_SLACK_TOKEN]')
        .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
        .replace(
          /https:\/\/(?:[a-z0-9-]+\.)*slack\.com\/files-pri\/[^\s"'<>]+/gi,
          '[REDACTED_SLACK_FILE_URL]',
        );
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.sanitize(item));
    }

    if (data && typeof data === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        // Redact known sensitive keys
        if (
          ['cookie', 'token', 'authorization', 'password', 'secret'].some((sensitive) =>
            key.toLowerCase().includes(sensitive),
          )
        ) {
          sanitized[key] = '[REDACTED]';
        } else {
          sanitized[key] = this.sanitize(value);
        }
      }
      return sanitized;
    }

    return data;
  }

  /**
   * Format log message
   */
  private format(level: LogLevel, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const levelUpper = level.toUpperCase().padEnd(5);
    let output = `[${timestamp}] ${levelUpper} ${message}`;

    if (data !== undefined) {
      const sanitized = this.sanitize(data);
      output += '\n' + JSON.stringify(sanitized, null, 2);
    }

    return output;
  }

  /**
   * Log debug message
   */
  debug(message: string, data?: unknown): void {
    if (this.shouldLog('debug')) {
      console.error(this.format('debug', message, data));
    }
  }

  /**
   * Log info message
   */
  info(message: string, data?: unknown): void {
    if (this.shouldLog('info')) {
      console.error(this.format('info', message, data));
    }
  }

  /**
   * Log warning message
   */
  warn(message: string, data?: unknown): void {
    if (this.shouldLog('warn')) {
      console.error(this.format('warn', message, data));
    }
  }

  /**
   * Log error message
   */
  error(message: string, error?: unknown): void {
    if (this.shouldLog('error')) {
      let errorData: unknown = error;

      if (error instanceof Error) {
        errorData = {
          name: error.name,
          message: error.message,
          stack: error.stack,
        };
      }

      console.error(this.format('error', message, errorData));
    }
  }
}

// Export singleton instance
export const logger = new Logger((process.env.LOG_LEVEL as LogLevel) || 'info');
