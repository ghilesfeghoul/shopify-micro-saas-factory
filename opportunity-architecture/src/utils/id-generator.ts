/**
 * Generate a human-readable spec ID like SPEC-A1B2.
 * 4 alphanumeric uppercase chars = 36^4 = 1.6M possibilities (sufficient).
 * On collision, the DB unique constraint will reject and we retry.
 */
export function generateSpecId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'SPEC-';
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
