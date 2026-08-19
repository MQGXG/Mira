/**
 * Dialog Service — 文件/目录对话框
 */

export const DialogService = {
  async openDirectory(): Promise<string[]> {
    return window.electronAPI.openDirectory()
  },

  async openFile(): Promise<{ token: string; files: Array<{ path: string; name: string; size: number }>; error?: string }> {
    return window.electronAPI.openFile()
  },

  /** 读取已选择附件（token 授权） */
  async readPickedFile(token: string, filePath: string): Promise<ArrayBuffer> {
    return window.electronAPI.readPickedFile(token, filePath)
  },

  /** 释放附件授权 */
  async releasePickedFiles(token: string): Promise<void> {
    return window.electronAPI.releasePickedFiles(token)
  },

  async saveFile(name: string): Promise<string> {
    return window.electronAPI.saveFile(name)
  },

  /**
   * 保存文本文件到用户指定路径（保存对话框 + 主进程写入）
   * @returns 写入成功返回 true；用户取消或写入失败返回 false
   */
  async saveTextFile(defaultName: string, content: string): Promise<boolean> {
    const filePath = await window.electronAPI.saveFile(defaultName)
    if (!filePath) return false
    return window.electronAPI.ts.writeFile(filePath, content)
  },
}
