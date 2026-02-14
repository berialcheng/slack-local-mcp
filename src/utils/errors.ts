/**
 * Error handling utilities for the Slack MCP server
 */

import {
  SlackError,
  AuthenticationError,
  RateLimitError,
  NotFoundError,
  ValidationError,
  PermissionError,
  SlackErrorResponse,
} from '../types.js';
import { logger } from './logger.js';

/**
 * Map Slack API error codes to custom error classes
 */
export function handleSlackError(
  error: unknown,
  context?: string
): SlackError {
  // Handle Axios errors
  if (error && typeof error === 'object' && 'response' in error) {
    const axiosError = error as {
      response?: {
        status: number;
        data: SlackErrorResponse | string;
        headers?: Record<string, string>;
      };
      message: string;
    };

    const status = axiosError.response?.status;
    const data = axiosError.response?.data;
    const errorCode = typeof data === 'object' ? data.error : undefined;
    const errorMessage = typeof data === 'object' ? data.error : axiosError.message;

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
          { errorCode, status }
        );

      case 403:
        return new PermissionError(
          `Permission denied${context ? ` (${context})` : ''}: ${errorMessage}`,
          { errorCode, status }
        );

      case 404:
        return new NotFoundError(
          `Resource not found${context ? ` (${context})` : ''}: ${errorMessage}`,
          { errorCode, status }
        );

      case 429: {
        const retryAfter = axiosError.response?.headers?.['retry-after'];
        const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : 60;
        return new RateLimitError(
          `Rate limit exceeded${context ? ` (${context})` : ''}. Retry after ${retrySeconds} seconds.`,
          retrySeconds,
          { errorCode, status }
        );
      }

      default:
        // Map common Slack error codes
        switch (errorCode) {
          case 'invalid_auth':
          case 'account_inactive':
          case 'token_revoked':
          case 'no_permission':
          case 'org_login_required':
            return new AuthenticationError(
              `Authentication error${context ? ` (${context})` : ''}: ${errorCode}`,
              { errorCode, status }
            );

          case 'channel_not_found':
          case 'user_not_found':
          case 'message_not_found':
          case 'thread_not_found':
            return new NotFoundError(
              `Not found${context ? ` (${context})` : ''}: ${errorCode}`,
              { errorCode, status }
            );

          case 'not_in_channel':
          case 'cannot_dm_bot':
          case 'restricted_action':
            return new PermissionError(
              `Permission error${context ? ` (${context})` : ''}: ${errorCode}`,
              { errorCode, status }
            );

          case 'invalid_arguments':
          case 'invalid_channel':
          case 'invalid_name':
          case 'invalid_timestamp':
            return new ValidationError(
              `Validation error${context ? ` (${context})` : ''}: ${errorCode}`,
              { errorCode, status }
            );

          default:
            return new SlackError(
              `Slack API error${context ? ` (${context})` : ''}: ${errorMessage}`,
              errorCode || 'UNKNOWN_ERROR',
              status,
              { errorCode, status }
            );
        }
    }
  }

  // Handle our custom errors
  if (error instanceof SlackError) {
    return error;
  }

  // Handle generic errors
  if (error instanceof Error) {
    logger.error('Unexpected error', error);
    return new SlackError(
      `Unexpected error${context ? ` (${context})` : ''}: ${error.message}`,
      'INTERNAL_ERROR',
      undefined,
      { originalError: error.message }
    );
  }

  // Unknown error type
  logger.error('Unknown error type', error);
  return new SlackError(
    `Unknown error${context ? ` (${context})` : ''}`,
    'UNKNOWN_ERROR',
    undefined,
    { error }
  );
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

/**
 * Wrap async function with error handling
 */
export function withErrorHandling<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  context?: string
): T {
  return (async (...args: unknown[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      throw handleSlackError(error, context);
    }
  }) as T;
}

/**
 * Check if error is a specific type
 */
export function isAuthError(error: unknown): error is AuthenticationError {
  return error instanceof AuthenticationError;
}

export function isRateLimitError(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError;
}

export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

export function isPermissionError(error: unknown): error is PermissionError {
  return error instanceof PermissionError;
}