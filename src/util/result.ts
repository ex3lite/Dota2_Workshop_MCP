// Helpers for building MCP tool results.

export type ContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

export interface ToolResult {
  // Index signature so this is assignable to the SDK's CallToolResult (which is
  // extensible via _meta and carries an index signature).
  [key: string]: unknown;
  content: ContentItem[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function text(message: string): ToolResult {
  return { content: [{ type: "text", text: message }] };
}

/** An image result (base64 data) with an optional text caption. */
export function image(data: string, mimeType: string, caption?: string): ToolResult {
  const content: ContentItem[] = [{ type: "image", data, mimeType }];
  if (caption) content.unshift({ type: "text", text: caption });
  return { content };
}

/** Structured result: returns both a text fallback and structuredContent. */
export function json(data: Record<string, unknown>, summary?: string): ToolResult {
  return {
    content: [{ type: "text", text: summary ?? JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function error(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wrap an async tool handler so thrown errors become clean error results. */
export function guard<A extends unknown[]>(
  fn: (...args: A) => Promise<ToolResult>,
): (...args: A) => Promise<ToolResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return error(`Error: ${message}`);
    }
  };
}
