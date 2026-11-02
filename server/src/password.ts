import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// scrypt aus node:crypto statt argon2: keine native Abhängigkeit, für einen Einzelnutzer ausreichend.
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(pw, salt, 64).toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const a = scryptSync(pw, Buffer.from(salt, "hex"), 64);
  return timingSafeEqual(a, Buffer.from(hash, "hex"));
}
