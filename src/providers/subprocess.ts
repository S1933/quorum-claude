export async function readPreviewedStdout(
  stream: ReadableStream<Uint8Array>,
  opts: { onToken(text: string): void },
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    chunks.push(chunk);
    opts.onToken(chunk);
  }

  const tail = decoder.decode();
  if (tail) chunks.push(tail);
  return chunks.join('');
}
