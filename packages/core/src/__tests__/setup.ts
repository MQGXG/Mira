import { initDatabase } from "../system/database"
import { initPlatformPaths } from "../config/paths"

// 为测试环境设置路径（避免依赖 Electron 的 app.getPath）
initPlatformPaths({
  userData: process.cwd() + "/.test-data",
  home: process.env.HOME || process.env.USERPROFILE || "/tmp",
})

// 在所有测试前初始化内存数据库
await initDatabase()

