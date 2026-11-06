/**
 * The server's console output, redacted (D-060). Error messages from viem, the
 * Hedera SDK and fetch can quote request URLs, and hosted RPC URLs carry their
 * API key in the path; on Render the console is the service log. Every line
 * the server prints goes through `redactText` first.
 */
import { redactText } from './api/redact.ts';

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const logInfo = (line: string): void => console.log(redactText(line));

export const logError = (line: string): void => console.error(redactText(line));
