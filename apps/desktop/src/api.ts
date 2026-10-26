import type { ArchiveSource, SearchRequest, SearchResponse } from './types';

const API = window.foxtail?.apiBaseUrl ?? 'http://127.0.0.1:8787/api/v1';

export async function searchArchive(request: SearchRequest, signal?: AbortSignal, onProgress?: (data: SearchResponse) => void): Promise<SearchResponse> {
  const response = await fetch(`${API}/search/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, limit: request.limit ?? 60 }),
    signal,
  });
  if (!response.ok) throw new Error(`Search failed: HTTP ${response.status}`);
  if (!response.body) throw new Error('Search response was empty.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let complete: SearchResponse | undefined;
  function accept(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line) as {type: string; data: SearchResponse};
    if (event.type === 'complete') complete = event.data;
    else if (event.type === 'progress') onProgress?.(event.data);
  }
  try {
    while (true) {
      const {value, done} = await reader.read();
      pending += decoder.decode(value, {stream: !done});
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) accept(line);
      if (done) break;
    }
    accept(pending);
    if (!complete) throw new Error('Connection interrupted before every archive responded.');
    return complete;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function getArchiveSources(): Promise<ArchiveSource[]> {
  const response = await fetch(`${API}/sources`);
  if (!response.ok) throw new Error(`Source catalog failed: HTTP ${response.status}`);
  return response.json();
}

export async function getHealth(): Promise<{status: string; database: string; adapters: string[]; connectivity: string}> {
  const response = await fetch(`${API}/health`);
  if (!response.ok) throw new Error(`Health check failed: HTTP ${response.status}`);
  const local = await response.json();
  const connectivity = await fetch(`${API}/connectivity`)
    .then(async (result) => result.ok ? (await result.json()).status : 'unknown')
    .catch(() => 'unknown');
  return {...local, connectivity};
}
