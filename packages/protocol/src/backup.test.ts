import { describe, expect, it } from "vitest";
import { ARGON2_ITERATIONS, ARGON2_MEMORY_KIB, BACKUP_ITERATIONS, BackupParams, BackupParamsResponse, BackupUploadRequest, backupParamsResponseOf, backupWeak, createBackup, deriveBackupKeys, openBackup } from "./index";

// Small parameters keep the tests fast; the derivation is the same as with the clients' values.
const SEED = "0f".repeat(32);
const SMALL = { memoryKib: 8192, iterations: 1 } as const;
const PBKDF2 = { kdf: "pbkdf2-sha256", iterations: 1000 } as const;

describe("backup (M6b)", () => {
  it("round-trips the seed with the right password (Argon2id, the default since 5 October 2026)", async () => {
    const b = await createBackup("geheim-genug-lang", SEED, SMALL);
    expect(b.params.kdf).toBe("argon2id");
    if (b.params.kdf !== "argon2id") throw new Error("kdf");
    expect(b.params).toMatchObject({ memoryKib: 8192, iterations: 1, parallelism: 1 });
    const keys = await deriveBackupKeys("geheim-genug-lang", backupParamsResponseOf(b.params));
    expect(keys.authKey).toBe(b.authKey);
    expect(await openBackup(keys, b.params.iv, b.ciphertext)).toBe(SEED);
  });
  it("still opens a PBKDF2 backup from before, and makes one on request", async () => {
    const b = await createBackup("geheim-genug", SEED, PBKDF2);
    expect(b.params).toMatchObject({ kdf: "pbkdf2-sha256", iterations: 1000 });
    const keys = await deriveBackupKeys("geheim-genug", b.params);
    expect(keys.authKey).toBe(b.authKey);
    expect(await openBackup(keys, b.params.iv, b.ciphertext)).toBe(SEED);
  });
  it("rejects a wrong password (different auth key, decrypt fails)", async () => {
    const b = await createBackup("geheim-genug-lang", SEED, SMALL);
    const wrong = await deriveBackupKeys("geheim-genug-lanG", b.params);
    expect(wrong.authKey).not.toBe(b.authKey);
    await expect(openBackup(wrong, b.params.iv, b.ciphertext)).rejects.toBeDefined();
  });
  it("uses fresh salt and iv per backup", async () => {
    const a = await createBackup("pw-pw-pw-pw-pw", SEED, SMALL);
    const b = await createBackup("pw-pw-pw-pw-pw", SEED, SMALL);
    expect(a.params.salt).not.toBe(b.params.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
  it("the defaults are the clients' values, and the same password gives different keys under the two KDFs", async () => {
    const a = await createBackup("pw-pw-pw-pw-pw", SEED);
    expect(a.params).toMatchObject({ kdf: "argon2id", memoryKib: ARGON2_MEMORY_KIB, iterations: ARGON2_ITERATIONS, parallelism: 1 });
    const p = await createBackup("pw-pw-pw-pw-pw", SEED, { kdf: "pbkdf2-sha256" });
    expect(p.params).toMatchObject({ kdf: "pbkdf2-sha256", iterations: BACKUP_ITERATIONS });
    expect(a.authKey).not.toBe(p.authKey);
  }, 30_000);
  it("upload request schema accepts both kinds of backup and refuses malformed parameters", async () => {
    const a = await createBackup("pw-pw-pw-pw-pw", SEED, SMALL);
    const p = await createBackup("pw-pw-pw-pw-pw", SEED, { kdf: "pbkdf2-sha256", iterations: 100_000 });
    for (const b of [a, p]) {
      const req = { publicKey: "ab".repeat(32), challengeId: "6f1c2a4e-1b2c-4d3e-8f90-123456789abc", signature: "cd".repeat(64), ciphertext: b.ciphertext, params: b.params, authKey: b.authKey };
      expect(BackupUploadRequest.safeParse(req).success).toBe(true);
      expect(BackupUploadRequest.safeParse({ ...req, params: { ...b.params, iterations: 0 } }).success).toBe(false);
      expect(BackupUploadRequest.safeParse({ ...req, params: { ...b.params, kdf: "scrypt" } }).success).toBe(false);
    }
    expect(BackupParams.safeParse({ kdf: "argon2id", memoryKib: 1024, iterations: 3, parallelism: 1, salt: "a".repeat(32), iv: "b".repeat(24) }).success).toBe(false);
    expect(BackupParams.safeParse({ kdf: "argon2id", memoryKib: 65536, iterations: 3, salt: "a".repeat(32), iv: "b".repeat(24) }).success).toBe(false);
    expect(BackupParamsResponse.safeParse(backupParamsResponseOf(a.params)).success).toBe(true);
    expect(BackupParamsResponse.safeParse(backupParamsResponseOf(p.params)).success).toBe(true);
    expect("iv" in backupParamsResponseOf(a.params)).toBe(false);
  });
  it("names a weak backup the service must refuse (security audit of 5 October 2026, L-1)", () => {
    const salt = "a".repeat(32);
    expect(backupWeak({ kdf: "pbkdf2-sha256", iterations: BACKUP_ITERATIONS, salt })).toBe(false);
    expect(backupWeak({ kdf: "pbkdf2-sha256", iterations: BACKUP_ITERATIONS - 1, salt })).toBe(true);
    expect(backupWeak({ kdf: "argon2id", memoryKib: ARGON2_MEMORY_KIB, iterations: ARGON2_ITERATIONS, parallelism: 1, salt })).toBe(false);
    expect(backupWeak({ kdf: "argon2id", memoryKib: ARGON2_MEMORY_KIB, iterations: ARGON2_ITERATIONS, parallelism: 4, salt })).toBe(false);
    expect(backupWeak({ kdf: "argon2id", memoryKib: ARGON2_MEMORY_KIB / 2, iterations: ARGON2_ITERATIONS, parallelism: 1, salt })).toBe(true);
    expect(backupWeak({ kdf: "argon2id", memoryKib: ARGON2_MEMORY_KIB, iterations: ARGON2_ITERATIONS - 1, parallelism: 1, salt })).toBe(true);
  });
});

describe("backups bound to a host (server accounts, 25 September 2026)", () => {
  const seed = "11".repeat(32);
  it("give another auth key than the unbound derivation, and open only with the same host", async () => {
    const b = await createBackup("richtig-lang-genug", seed, SMALL, "chat.example.org");
    expect(b.params.bound).toBe(true);
    const unbound = await deriveBackupKeys("richtig-lang-genug", b.params);
    const other = await deriveBackupKeys("richtig-lang-genug", b.params, "evil.example");
    const same = await deriveBackupKeys("richtig-lang-genug", b.params, "chat.example.org");
    expect(unbound.authKey).not.toBe(b.authKey);
    expect(other.authKey).not.toBe(b.authKey);
    expect(same.authKey).toBe(b.authKey);
    expect(await openBackup(same, b.params.iv, b.ciphertext)).toBe(seed);
    await expect(openBackup(unbound, b.params.iv, b.ciphertext)).rejects.toBeTruthy();
    expect(backupParamsResponseOf(b.params).bound).toBe(true);
  });
  it("leave the directory's backups as they were (no context, no flag)", async () => {
    const b = await createBackup("richtig-lang-genug", seed, SMALL);
    expect(b.params.bound).toBeUndefined();
    expect((await deriveBackupKeys("richtig-lang-genug", b.params)).authKey).toBe(b.authKey);
    expect(backupParamsResponseOf(b.params).bound).toBeUndefined();
  });
});
