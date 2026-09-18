import type { IncomingMessage } from 'node:http';
import { ERRORS, BridgeError } from '@codex-bridge/shared';
import type { MessagesRequest } from '@codex-bridge/shared';

/** Read a JSON body with a hard size cap, aborting the stream once exceeded. */
export function readJsonBody<T = unknown>(req: IncomingMessage, maxBytes: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      // Stop reading, but leave the socket alive: destroying it here would
      // reset the connection before the 413 could be written, and the client
      // would see a transport error instead of a usable API error.
      req.pause();
      chunks.length = 0;
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(ERRORS.tooLarge(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => fail(new BridgeError('invalid_request', `Could not read the request body: ${err.message}`)));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        reject(ERRORS.invalid('Request body is empty.'));
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(ERRORS.invalid(`Request body is not valid JSON: ${(err as Error).message}`));
      }
    });
  });
}

/**
 * Read a JSON body and keep the raw bytes.
 *
 * The passthrough forwards the body untouched, and routing needs the parsed
 * `model` to decide where it goes — so the socket is read exactly once and both
 * forms are returned.
 */
export async function readJsonBodyWithRaw(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ raw: unknown; buffer: Buffer }> {
  const buffer = await readRawBody(req, maxBytes);
  const text = buffer.toString('utf8');
  if (!text.trim()) throw ERRORS.invalid('Request body is empty.');
  try {
    return { raw: JSON.parse(text) as unknown, buffer };
  } catch (err) {
    throw ERRORS.invalid(`Request body is not valid JSON: ${(err as Error).message}`);
  }
}

export function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        req.pause();
        chunks.length = 0;
        reject(ERRORS.tooLarge(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new BridgeError('invalid_request', `Could not read the request body: ${err.message}`));
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Validate an Anthropic Messages request.
 *
 * Deliberately permissive about extra fields (Claude Code sends betas and
 * vendor extras we simply ignore) and strict about the shape we must be able to
 * translate.
 */
export function validateMessagesRequest(body: unknown): MessagesRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw ERRORS.invalid('Request body must be a JSON object.');
  }
  const req = body as Record<string, unknown>;

  if (typeof req['model'] !== 'string' || !req['model']) {
    throw ERRORS.invalid('`model` is required and must be a string.');
  }
  const maxTokens = req['max_tokens'];
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw ERRORS.invalid('`max_tokens` is required and must be a positive number.');
  }
  const messages = req['messages'];
  if (!Array.isArray(messages)) {
    throw ERRORS.invalid('`messages` is required and must be an array.');
  }
  if (messages.length === 0) {
    throw ERRORS.invalid('`messages` must contain at least one message.');
  }
  messages.forEach((m, i) => validateMessage(m, i));

  const system = req['system'];
  if (system !== undefined && typeof system !== 'string' && !Array.isArray(system)) {
    throw ERRORS.invalid('`system` must be a string or an array of text blocks.');
  }

  const tools = req['tools'];
  if (tools !== undefined && !Array.isArray(tools)) {
    throw ERRORS.invalid('`tools` must be an array.');
  }

  const stream = req['stream'];
  if (stream !== undefined && typeof stream !== 'boolean') {
    throw ERRORS.invalid('`stream` must be a boolean.');
  }

  return req as unknown as MessagesRequest;
}

function validateMessage(msg: unknown, index: number): void {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    throw ERRORS.invalid(`messages[${index}] must be an object.`);
  }
  const m = msg as Record<string, unknown>;
  // `system` is accepted because Claude Code really does send it mid-conversation.
  if (m['role'] !== 'user' && m['role'] !== 'assistant' && m['role'] !== 'system') {
    throw ERRORS.invalid(
      `messages[${index}].role must be "user", "assistant" or "system" (got ${JSON.stringify(m['role'])}).`,
    );
  }
  const content = m['content'];
  if (typeof content === 'string') return;
  if (!Array.isArray(content)) {
    throw ERRORS.invalid(`messages[${index}].content must be a string or an array of blocks.`);
  }
  content.forEach((block, bi) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw ERRORS.invalid(`messages[${index}].content[${bi}] must be an object.`);
    }
    const b = block as Record<string, unknown>;
    if (typeof b['type'] !== 'string') {
      throw ERRORS.invalid(`messages[${index}].content[${bi}].type is required.`);
    }
    if (b['type'] === 'tool_result' && typeof b['tool_use_id'] !== 'string') {
      throw ERRORS.invalid(`messages[${index}].content[${bi}].tool_use_id is required for tool_result.`);
    }
    if (b['type'] === 'tool_use') {
      if (typeof b['id'] !== 'string') {
        throw ERRORS.invalid(`messages[${index}].content[${bi}].id is required for tool_use.`);
      }
      if (typeof b['name'] !== 'string') {
        throw ERRORS.invalid(`messages[${index}].content[${bi}].name is required for tool_use.`);
      }
    }
  });
}
