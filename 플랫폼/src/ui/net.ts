// Requests to the ledger server. A request that cannot reach the server (Wi-Fi gone, server restarting) is tried
// again with the same body, and so the same key, until it gets an answer or `retryMs` runs out; the server answers
// a repeated key with its first answer, so nothing happens twice.
import { ERROR_TEXT, type ErrorCode } from '../shared/protocol.ts';

export class ApiError extends Error {
  readonly code: ErrorCode | 'network';
  readonly status: number;
  constructor(code: ErrorCode | 'network', message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface CallOptions {
  token?: string;
  retryMs?: number; // keep trying this long when the server cannot be reached (0: once)
  onRetry?: (attempt: number) => void;
}

const ATTEMPT_MS = 8000;

export async function api<T>(base: string, path: string, body?: unknown, o: CallOptions = {}): Promise<T> {
  const end = Date.now() + (o.retryMs ?? 0);
  for (let attempt = 1; ; attempt++) {
    try {
      return await once<T>(base, path, body, o.token);
    } catch (e) {
      const retry = e instanceof ApiError && (e.code === 'network' || e.status >= 500);
      if (!retry || Date.now() >= end) throw e;
      o.onRetry?.(attempt);
      await new Promise((r) => setTimeout(r, Math.min(4000, 400 * 2 ** (attempt - 1))));
    }
  }
}

async function once<T>(base: string, path: string, body: unknown, token?: string): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ATTEMPT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch {
    throw new ApiError('network', '서버에 연결할 수 없습니다', 0);
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // not JSON
  }
  if (res.ok) return data as T;
  const err = data as { error?: ErrorCode; message?: string } | null;
  const code = err?.error ?? 'bad_request';
  throw new ApiError(code, err?.message ?? ERROR_TEXT[code] ?? '오류', res.status);
}
