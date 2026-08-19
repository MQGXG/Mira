export interface PlatformPaths {
  userData: string
  home: string
  /** 本地模型资源目录（打包后为 process.resourcesPath/models，开发时为仓库内 resources/models） */
  modelDir: string
}

const currentPaths: PlatformPaths = {
  userData: process.cwd(),
  home: process.env.HOME || process.env.USERPROFILE || "/tmp",
  modelDir: "",
}

export function initPlatformPaths(paths: Partial<PlatformPaths>): void {
  if (paths.userData !== undefined) currentPaths.userData = paths.userData
  if (paths.home !== undefined) currentPaths.home = paths.home
  if (paths.modelDir !== undefined) currentPaths.modelDir = paths.modelDir
}

export function getPlatformPaths(): PlatformPaths {
  return currentPaths
}
