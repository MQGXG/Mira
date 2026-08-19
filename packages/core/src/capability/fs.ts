/**
 * FileSystem seam (capability: "fs")
 *
 * Service Definition: {@link FileSystemProvider} — the file IO contract consumed
 * by read_file / write_file / list_files / grep tools.
 * Service Provider: {@link LocalFileSystemProvider} — the default local implementation.
 * Swapping the provider (e.g. to a remote sandbox) relocates file IO product-wide.
 */

import * as fs from "fs/promises"
import { createReadStream } from "fs"
import type { Readable } from "stream"
import { capabilityRegistry } from "./index"

export const FS_CAPABILITY = "fs"

export interface FsStats {
  size: number
  isDirectory: boolean
  isFile: boolean
  mtimeMs: number
}

export interface FsEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
}

export interface FileSystemProvider {
  readonly name: string
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  stat(path: string): Promise<FsStats | null>
  readdir(path: string): Promise<FsEntry[]>
  mkdir(path: string, recursive?: boolean): Promise<void>
  exists(path: string): Promise<boolean>
  createReadStream(path: string, options?: { start?: number; end?: number }): Readable
}

export class LocalFileSystemProvider implements FileSystemProvider {
  readonly name = "local"

  async readFile(path: string): Promise<Buffer> {
    return await fs.readFile(path)
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await fs.writeFile(path, data)
  }

  async stat(path: string): Promise<FsStats | null> {
    try {
      const st = await fs.stat(path)
      return {
        size: st.size,
        isDirectory: st.isDirectory(),
        isFile: st.isFile(),
        mtimeMs: st.mtimeMs,
      }
    } catch {
      return null
    }
  }

  async readdir(path: string): Promise<FsEntry[]> {
    const entries = await fs.readdir(path, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }))
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await fs.mkdir(path, { recursive })
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path)
      return true
    } catch {
      return false
    }
  }

  createReadStream(path: string, options?: { start?: number; end?: number }): Readable {
    return createReadStream(path, options)
  }
}

/** The default local provider, used when no other provider is registered. */
const defaultFsProvider = new LocalFileSystemProvider()

/** Get the active file system provider (registered one or local default). */
export function getFs(): FileSystemProvider {
  return capabilityRegistry.get<FileSystemProvider>(FS_CAPABILITY) ?? defaultFsProvider
}

export { defaultFsProvider }
