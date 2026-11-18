import type { Server } from 'node:http';

export interface ServerTimeouts {
  /** Whole request (incl. a slow multipart upload) must arrive within this. */
  requestTimeoutMs: number;
  /** Headers must arrive within this (slowloris protection). */
  headersTimeoutMs: number;
  /** Idle keep-alive; above the proxy's idle timeout to avoid 502 races. */
  keepAliveTimeoutMs: number;
}

export function timeoutsFor(requestTimeoutMs: number): ServerTimeouts {
  return {
    requestTimeoutMs,
    headersTimeoutMs: Math.min(30_000, requestTimeoutMs),
    keepAliveTimeoutMs: 65_000,
  };
}

export function applyTimeouts(server: Server, t: ServerTimeouts): void {
  server.requestTimeout = t.requestTimeoutMs;
  server.headersTimeout = t.headersTimeoutMs;
  server.keepAliveTimeout = t.keepAliveTimeoutMs;
}
