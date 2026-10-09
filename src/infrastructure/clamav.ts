import { once } from "node:events";
import { createConnection, type Socket, type TcpNetConnectOpts } from "node:net";
import type { Readable } from "node:stream";

export type ClamAvEndpoint = { socketPath: string } | { host: string; port: number };
export type ClamAvInstreamConfiguration = {
  endpoint: ClamAvEndpoint;
  /** Idle timeout of the socket (connect, upload stalls and the verdict wait). */
  timeoutMilliseconds: number;
  /** Wall-clock cap for one whole scan, however slowly bytes keep flowing (default 10 minutes). */
  deadlineMilliseconds?: number;
  maximumBytes: number;
  chunkBytes: number;
};
export type ClamAvInstreamFailure =
  | "CONFIGURATION_INVALID"
  | "SIZE_EXCEEDED"
  | "SIZE_MISMATCH"
  | "UNAVAILABLE";

export class ClamAvInstreamError extends Error {
  constructor(public readonly kind: ClamAvInstreamFailure, message: string) {
    super(message);
    this.name = "ClamAvInstreamError";
  }
}

export function clamAvEndpoint(input: {
  socketPath?: string;
  host?: string;
  port?: string | number;
}): ClamAvEndpoint | undefined {
  const socketPath = input.socketPath?.trim();
  const host = input.host?.trim();
  const port = Number(input.port);
  if (socketPath && (host || input.port !== undefined))
    throw new ClamAvInstreamError("CONFIGURATION_INVALID", "ClamAV must use either a socket or host and port");
  if (socketPath) return { socketPath };
  if (!host && input.port === undefined) return undefined;
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535)
    throw new ClamAvInstreamError("CONFIGURATION_INVALID", "ClamAV host and port are invalid");
  return { host, port };
}

/**
 * Shared `CORECROW_CLAMAV_*` configuration (legacy `NORTH_DATA_IMPORT_CLAMAV_*` endpoint variables still work).
 * Returns undefined when no endpoint is configured. `ceilingBytes` is the caller's own maximum; the shared
 * `CORECROW_CLAMAV_MAX_BYTES` can only lower it, never raise it.
 */
export function clamAvConfigurationFromEnvironment(ceilingBytes: number, environment: NodeJS.ProcessEnv = process.env): ClamAvInstreamConfiguration | undefined {
  const endpoint = clamAvEndpoint({
    socketPath: environment.CORECROW_CLAMAV_SOCKET ?? environment.NORTH_DATA_IMPORT_CLAMAV_SOCKET,
    host: environment.CORECROW_CLAMAV_HOST ?? environment.NORTH_DATA_IMPORT_CLAMAV_HOST,
    port: environment.CORECROW_CLAMAV_PORT ?? environment.NORTH_DATA_IMPORT_CLAMAV_PORT,
  });
  if (!endpoint) return undefined;
  const timeoutMilliseconds = Number(environment.CORECROW_CLAMAV_TIMEOUT_MS ?? 30_000);
  return {
    endpoint,
    timeoutMilliseconds,
    deadlineMilliseconds: Number(environment.CORECROW_CLAMAV_DEADLINE_MS ?? 10 * 60_000),
    maximumBytes: Math.min(Number(environment.CORECROW_CLAMAV_MAX_BYTES ?? ceilingBytes), ceilingBytes),
    chunkBytes: Number(environment.CORECROW_CLAMAV_CHUNK_BYTES ?? 64 * 1024),
  };
}

const DEFAULT_DEADLINE_MS = 10 * 60_000;
const unavailable = (message = "ClamAV is unavailable") =>
  new ClamAvInstreamError("UNAVAILABLE", message);

function connectionOptions(endpoint: ClamAvEndpoint): TcpNetConnectOpts | { path: string } {
  return "socketPath" in endpoint ? { path: endpoint.socketPath } : endpoint;
}

async function writeWithBackpressure(socket: Socket, value: Buffer) {
  if (socket.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("timeout", onTimeout);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(unavailable()); };
    const onClose = () => { cleanup(); reject(unavailable("ClamAV closed during upload")); };
    const onTimeout = () => { cleanup(); reject(unavailable("ClamAV timed out during upload")); };
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("timeout", onTimeout);
  });
}

export async function scanClamAvInstream(
  configuration: ClamAvInstreamConfiguration,
  input: { size: number; openPrivateRead: () => Promise<Readable>; signal: AbortSignal },
): Promise<"CLEAN" | "INFECTED"> {
  if (input.signal.aborted) throw input.signal.reason ?? new Error("ClamAV scan aborted");
  const deadlineMilliseconds = configuration.deadlineMilliseconds ?? DEFAULT_DEADLINE_MS;
  if (
    !Number.isSafeInteger(configuration.timeoutMilliseconds) || configuration.timeoutMilliseconds <= 0 ||
    !Number.isSafeInteger(deadlineMilliseconds) || deadlineMilliseconds <= 0 ||
    !Number.isSafeInteger(configuration.maximumBytes) || configuration.maximumBytes <= 0 ||
    !Number.isSafeInteger(configuration.chunkBytes) || configuration.chunkBytes <= 0 || configuration.chunkBytes > 1024 * 1024
  ) throw new ClamAvInstreamError("CONFIGURATION_INVALID", "ClamAV scanner configuration is invalid");
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > configuration.maximumBytes)
    throw new ClamAvInstreamError("SIZE_EXCEEDED", "Object exceeds the ClamAV scan limit");

  const socket = createConnection(connectionOptions(configuration.endpoint));
  socket.setTimeout(configuration.timeoutMilliseconds);
  // The caller's signal and the wall-clock deadline both tear the socket down; only the caller's abort is re-thrown as such.
  const stop = AbortSignal.any([input.signal, AbortSignal.timeout(deadlineMilliseconds)]);
  const abort = () => socket.destroy(input.signal.reason ?? new Error("ClamAV scan aborted"));
  stop.addEventListener("abort", abort, { once: true });
  let responseBytes = 0;
  let receivedTerminator = false;
  const response: Buffer[] = [];
  const reply = new Promise<string>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => {
      responseBytes += chunk.byteLength;
      if (responseBytes > 4_096) {
        reject(unavailable("ClamAV returned an oversized response"));
        socket.destroy();
        return;
      }
      const terminator = chunk.indexOf(0);
      response.push(terminator >= 0 ? chunk.subarray(0, terminator) : chunk);
      if (terminator >= 0) {
        receivedTerminator = true;
        resolve(Buffer.concat(response).toString("utf8").trim());
      }
    });
    socket.once("timeout", () => {
      reject(unavailable("ClamAV timed out"));
      socket.destroy();
    });
    socket.once("error", () => reject(unavailable()));
    socket.once("close", () => {
      if (!receivedTerminator) reject(unavailable("ClamAV returned a truncated response"));
    });
  });
  void reply.catch(() => undefined);

  try {
    await once(socket, "connect");
    await writeWithBackpressure(socket, Buffer.from("zINSTREAM\0"));
    let streamed = 0;
    const stream = await input.openPrivateRead();
    try {
      for await (const value of stream) {
        if (stop.aborted) throw input.signal.reason ?? unavailable("ClamAV scan deadline exceeded");
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        streamed += chunk.byteLength;
        if (streamed > input.size || streamed > configuration.maximumBytes)
          throw new ClamAvInstreamError("SIZE_MISMATCH", "Object size does not match its declaration");
        for (let offset = 0; offset < chunk.byteLength; offset += configuration.chunkBytes) {
          const part = chunk.subarray(offset, offset + configuration.chunkBytes);
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(part.byteLength);
          await writeWithBackpressure(socket, length);
          await writeWithBackpressure(socket, part);
        }
      }
    } finally {
      stream.destroy();
    }
    if (streamed !== input.size)
      throw new ClamAvInstreamError("SIZE_MISMATCH", "Object size does not match its declaration");
    await writeWithBackpressure(socket, Buffer.alloc(4));
    const result = await reply;
    if (/^stream:\s+OK$/i.test(result)) return "CLEAN";
    if (/^stream:\s+.+\s+FOUND$/i.test(result)) return "INFECTED";
    throw unavailable("ClamAV returned an invalid result");
  } catch (error) {
    if (error instanceof ClamAvInstreamError) throw error;
    if (input.signal.aborted) throw input.signal.reason ?? error;
    throw unavailable();
  } finally {
    stop.removeEventListener("abort", abort);
    socket.destroy();
  }
}
