// Incremental SHA-256 of a File, 8 MiB at a time, so hashing a 2 GB video never holds
// a second full copy of it in memory. The File is passed by reference (no byte copy).
//   in:  { file }
//   out: { type: 'progress', progress } | { type: 'done', sha256 } | { type: 'error', message }

import { createSHA256 } from 'hash-wasm';

const CHUNK = 8 * 1024 * 1024;

self.onmessage = async ({ data }) => {
  const { file } = data;
  try {
    const hasher = await createSHA256();
    hasher.init();
    let lastReport = 0;
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
      hasher.update(bytes);
      const progress = Math.min(1, (offset + bytes.length) / file.size);
      if (progress - lastReport > 0.01 || progress === 1) {
        self.postMessage({ type: 'progress', progress });
        lastReport = progress;
      }
    }
    self.postMessage({ type: 'done', sha256: hasher.digest('hex') });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || 'Could not read the file.' });
  }
};
