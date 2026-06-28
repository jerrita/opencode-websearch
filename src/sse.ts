export function takeNextSseEvent(buffer: string): { rawEvent: string; rest: string } | null {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  const candidates = [lfIndex, crlfIndex].filter((index) => index >= 0);
  if (candidates.length === 0) return null;

  const boundary = Math.min(...candidates);
  const separatorLength = boundary === crlfIndex ? 4 : 2;
  return {
    rawEvent: buffer.slice(0, boundary),
    rest: buffer.slice(boundary + separatorLength),
  };
}

export function parseSseEventData(rawEvent: string): unknown | "[DONE]" | null {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();

  if (!data) return null;
  if (data === "[DONE]") return "[DONE]";

  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`;
  const text = await response.text().catch(() => "");
  if (!text) return fallback;

  try {
    const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return json.error?.message ?? json.message ?? text;
  } catch {
    return text;
  }
}
