/**
 * Generate a human-readable app/run ID like APP-X3K9.
 * 4 alphanumeric uppercase chars = 36^4 = 1.6M possibilities.
 */
export function generateAppId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'APP-';
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/**
 * Generate a chunk ID like CHK-X3K9. Used internally to identify
 * sub-agent tasks inside a generation run.
 */
export function generateChunkId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'CHK-';
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
