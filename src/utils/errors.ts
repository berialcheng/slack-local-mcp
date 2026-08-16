/**
 * Error handling utilities for the Slack MCP server
 */

import type { SlackErrorResponse } from '../types.js';
import {
  SlackError,
  AuthenticationError,
  RateLimitError,
  NotFoundError,
  ValidationError,
  PermissionError,
  CancelledError,
} from '../types.js';

import { logger } from './logger.js';

/**
 * Map Slack API error codes to custom error classes
 */
export function handleSlackError(error: unknown, context?: string): SlackError {
  if (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      (error as Error & { code?: string }).code === 'ERR_CANCELED' ||
      (error as Error & { code?: string }).code === 'ABORT_ERR')
  ) {
    return new CancelledError(`Operation cancelled${context ? ` (${context})` : ''}`);
  }

  if (
    error instanceof Error &&
    error.name === 'ZodError' &&
    'issues' in error &&
    Array.isArray((error as Error & { issues?: unknown[] }).issues)
  ) {
    const issues = (error as Error & { issues: Array<{ path?: unknown[]; message?: string }> })
      .issues;
    const summary = issues
      .slice(0, 5)
      .map((issue) => `${issue.path?.join('.') || 'input'}: ${issue.message || 'invalid value'}`)
      .join('; ');
    return new ValidationError(`Invalid tool input${context ? ` (${context})` : ''}: ${summary}`, {
      issues: issues.length,
    });
  }

  // Handle Axios errors
  if (error && typeof error === 'object' && 'response' in error) {
    const axiosError = error as {
      response?: {
        status: number;
        data: SlackErrorResponse | string | null;
        headers?: Record<string, string>;
      };
      message: string;
    };

    const status = axiosError.response?.status;
    const data = axiosError.response?.data;
    const slackErrorData = data !== null && typeof data === 'object' ? data : undefined;
    const errorCode = slackErrorData?.error;
    const errorMessage = slackErrorData?.error || axiosError.message;

    // Log the error for debugging
    logger.debug('Slack API error', {
      context,
      status,
      errorCode,
      message: errorMessage,
    });

    // Map to specific error types
    switch (status) {
      case 401:
        return new AuthenticationError(
          `Authentication failed${context ? ` (${context})` : ''}: ${errorMessage}`,
          { errorCode, status },
        );

      case 403:
        return new PermissionError(
          `Permission denied${context ? ` (${context})` : ''}: ${errorMessage}`,
          { errorCode, status },
        );

      case 404:
        return new NotFoundError(
          `Resource not found${context ? ` (${context})` : ''}: ${errorMessage}`,
          { errorCode, status },
        );

      case 429: {
        const retryAfter = axiosError.response?.headers?.['retry-after'];
        const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : 60;
        return new RateLimitError(
          `Rate limit exceeded${context ? ` (${context})` : ''}. Retry after ${retrySeconds} seconds.`,
          retrySeconds,
          { errorCode, status },
        );
      }

      default:
        return mapSlackApiError(errorCode, errorMessage, context, status);
    }
  }

  // Handle our custom errors
  if (error instanceof SlackError) {
    return error;
  }

  // Handle generic errors
  if (error instanceof Error) {
    if (/^[a-z][a-z0-9_]*$/i.test(error.message)) {
      return mapSlackApiError(error.message, error.message, context);
    }
    logger.error('Unexpected error', error);
    return new SlackError(
      `Unexpected error${context ? ` (${context})` : ''}: ${error.message}`,
      'INTERNAL_ERROR',
      undefined,
      { originalError: error.message },
    );
  }

  // Unknown error type
  logger.error('Unknown error type', error);
  return new SlackError(
    `Unknown error${context ? ` (${context})` : ''}`,
    'UNKNOWN_ERROR',
    undefined,
    { error },
  );
}

function mapSlackApiError(
  errorCode: string | undefined,
  errorMessage: string | undefined,
  context?: string,
  status?: number,
): SlackError {
  switch (errorCode) {
    case 'invalid_auth':
    case 'not_authed':
    case 'account_inactive':
    case 'token_expired':
    case 'token_revoked':
    case 'org_login_required':
      return new AuthenticationError(
        `Authentication error${context ? ` (${context})` : ''}: ${errorCode}`,
        { errorCode, status },
      );

    case 'channel_not_found':
    case 'user_not_found':
    case 'message_not_found':
    case 'thread_not_found':
    case 'file_not_found':
      return new NotFoundError(`Not found${context ? ` (${context})` : ''}: ${errorCode}`, {
        errorCode,
        status,
      });

    case 'no_permission':
    case 'not_in_channel':
    case 'cannot_dm_bot':
    case 'restricted_action':
      return new PermissionError(
        `Permission error${context ? ` (${context})` : ''}: ${errorCode}`,
        { errorCode, status },
      );

    case 'invalid_arguments':
    case 'invalid_channel':
    case 'invalid_name':
    case 'invalid_timestamp':
      return new ValidationError(
        `Validation error${context ? ` (${context})` : ''}: ${errorCode}`,
        { errorCode, status },
      );

    case 'ratelimited':
      return new RateLimitError(`Rate limit exceeded${context ? ` (${context})` : ''}.`, 60, {
        errorCode,
        status,
      });

    default:
      return new SlackError(
        `Slack API error${context ? ` (${context})` : ''}: ${errorMessage || 'Unknown error'}`,
        errorCode || 'UNKNOWN_ERROR',
        status,
        { errorCode, status },
      );
  }
}

/**
 * Format error for MCP response
 */
export function formatErrorForMCP(error: SlackError): {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
} {
  let message = `Error: ${error.message}`;

  // Add helpful context for common errors
  if (error instanceof AuthenticationError) {
    message += '\n\nPlease check that your SLACK_COOKIE_D is valid and not expired.';
    message += '\nYou may need to extract a fresh cookie from your browser.';
  } else if (error instanceof PermissionError) {
    message += '\n\nMake sure you have the necessary permissions for this action.';
    message += '\nYou may need to be added to the channel or have admin privileges.';
  } else if (error instanceof NotFoundError) {
    message += '\n\nPlease verify the channel ID, user ID, or message timestamp is correct.';
  } else if (error instanceof RateLimitError) {
    message += '\n\nPlease wait before making more requests.';
  } else if (error instanceof ValidationError) {
    message += '\n\nPlease check your input parameters.';
  }

  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    isError: true,
  };
}
