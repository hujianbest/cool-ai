import "server-only";

import { constants } from "node:fs";

import * as koffi from "koffi";

import { WindowsNativeError } from "@/src/modules/safe-execution";

export type PosixNativeKoffiFunctions = {
  close(fd: number): number;
  lseek(fd: number, offset: number, whence: number): number;
  fstatat(dirfd: number, path: string, output: Buffer, flags: number): number;
  getdirentries(fd: number, buffer: Buffer, bytes: number, basep: Buffer): number;
  mkdirat(dirfd: number, path: string, mode: number): number;
  // openat is variadic: each C variadic parameter takes two JS arguments
  // (type string, value) per the koffi calling convention; non-creating calls
  // pass none. A fixed-arity binding silently drops the mode (file created
  // with mode 000), so the variadic form is required.
  openat(dirfd: number, path: string, flags: number): number;
  openat(dirfd: number, path: string, flags: number, modeType: "int", mode: number): number;
  renameat(
    oldDirfd: number,
    oldPath: string,
    newDirfd: number,
    newPath: string,
  ): number;
  unlinkat(dirfd: number, path: string, flags: number): number;
};

export const POSIX_NATIVE_CONSTANTS = {
  at: {
    // Verified on the target kernel: any negative dirfd is treated as
    // AT_FDCWD, so the conventional -100 value is safe here.
    AT_FDCWD: -100,
    AT_SYMLINK_NOFOLLOW: 0x20,
  },
  whence: {
    SEEK_SET: 0,
  },
  open: {
    // Derived from the runtime's own fs.constants (darwin values): hardcoding
    // Linux flag bits here once opened symlinks silently and hung on O_ALERT.
    O_CREAT: constants.O_CREAT,
    O_DIRECTORY: constants.O_DIRECTORY ?? 0,
    O_EXCL: constants.O_EXCL,
    O_NOFOLLOW: constants.O_NOFOLLOW ?? 0,
    O_NONBLOCK: constants.O_NONBLOCK,
    O_RDONLY: constants.O_RDONLY,
    O_WRONLY: constants.O_WRONLY,
  },
  direntType: {
    DT_BLK: 6,
    DT_CHR: 2,
    DT_DIR: 4,
    DT_FIFO: 1,
    DT_LNK: 10,
    DT_REG: 8,
    DT_SOCK: 12,
    DT_UNKNOWN: 0,
    DT_WHT: 14,
  },
  stat: {
    S_IFMT: 0xf000,
    S_IFDIR: 0x4000,
    S_IFLNK: 0xa000,
    S_IFREG: 0x8000,
  },
  statLayout: {
    // struct stat (darwin, 64-bit inode, arm64 and x86_64 share this layout):
    // st_dev uint32 @0, st_mode uint16 @4, st_ino uint64 @8, st_size int64 @96.
    stDevOffset: 0,
    stModeOffset: 4,
    stInoOffset: 8,
    stSizeOffset: 96,
    statSize: 144,
  },
  // struct dirent (darwin legacy symbol layout):
  // d_ino uint32 @0, d_reclen uint16 @4, d_type uint8 @6, d_namlen uint8 @7,
  // d_name @8. The 32-bit enumeration inode is never used as identity; the
  // authoritative 64-bit identity comes from fstatat(AT_SYMLINK_NOFOLLOW).
  direntLayout: {
    fixedBytes: 8,
    maxNameBytes: 1024,
    nameOffset: 8,
    namlenOffset: 7,
    reclenOffset: 4,
    typeOffset: 6,
  },
} as const;

export function isPosixSupportedRuntime(
  platform: string = process.platform,
): boolean {
  return platform === "darwin";
}

function fail(message: string): never {
  throw new WindowsNativeError(message);
}

function loadFunctions(): PosixNativeKoffiFunctions {
  if (!isPosixSupportedRuntime()) {
    fail("The native sandbox adapter requires macOS.");
  }
  if (!POSIX_NATIVE_CONSTANTS.open.O_NOFOLLOW || !POSIX_NATIVE_CONSTANTS.open.O_NONBLOCK) {
    fail("The runtime open flags are unavailable on this platform.");
  }
  const libc = koffi.load("libSystem.B.dylib") as {
    func(signature: string): (...args: unknown[]) => unknown;
  };
  try {
    return {
      close: libc.func("int close(int)") as PosixNativeKoffiFunctions["close"],
      lseek: libc.func(
        "int64_t lseek(int, int64_t, int)",
      ) as PosixNativeKoffiFunctions["lseek"],
      fstatat: libc.func(
        "int fstatat(int, const char *, void *, int)",
      ) as PosixNativeKoffiFunctions["fstatat"],
      getdirentries: libc.func(
        "int getdirentries(int, char *, int, long *)",
      ) as PosixNativeKoffiFunctions["getdirentries"],
      mkdirat: libc.func(
        "int mkdirat(int, const char *, uint16_t)",
      ) as PosixNativeKoffiFunctions["mkdirat"],
      openat: libc.func(
        "int openat(int, const char *, int, ...)",
      ) as unknown as PosixNativeKoffiFunctions["openat"],
      renameat: libc.func(
        "int renameat(int, const char *, int, const char *)",
      ) as PosixNativeKoffiFunctions["renameat"],
      unlinkat: libc.func(
        "int unlinkat(int, const char *, int)",
      ) as PosixNativeKoffiFunctions["unlinkat"],
    };
  } catch (error) {
    if (error instanceof WindowsNativeError) throw error;
    return fail("The fixed macOS native symbols are unavailable.");
  }
}

let cached: PosixNativeKoffiFunctions | undefined;

export function getPosixNativeKoffiFunctions(
  loader: () => PosixNativeKoffiFunctions = loadFunctions,
): PosixNativeKoffiFunctions {
  cached ??= loader();
  return cached;
}

/** Test-only reset for the cached binding. */
export function __resetPosixNativeKoffiCache(): void {
  cached = undefined;
}

/** Reads the libc errno left by the last native call. */
export function posixErrno(): number {
  const errno = (koffi as unknown as { errno?: () => number }).errno?.();
  return typeof errno === "number" ? errno : 0;
}
