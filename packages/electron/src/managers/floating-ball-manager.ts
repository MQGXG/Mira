/**
 * 桌面悬浮球管理器
 * 参考 Qwen Audio Agent 的桌面悬浮球设计
 */

import { BrowserWindow, screen, globalShortcut, ipcMain, nativeImage } from 'electron'
import { join, resolve } from 'path'

/** 悬浮球状态 */
export type FloatingBallState = 'active' | 'hidden' | 'waking'

/** 悬浮球配置 */
export interface FloatingBallConfig {
  /** 悬浮球尺寸 */
  size?: number
  /** 距离屏幕边缘的间距 */
  margin?: number
  /** 自动隐藏超时 (ms) */
  autoHideTimeout?: number
  /** 快捷键 */
  shortcut?: string
  /** 是否启用语音唤醒 */
  wakeWordEnabled?: boolean
}

/** 拖拽状态 */
interface DragState {
  pointerX: number
  pointerY: number
  windowX: number
  windowY: number
}

/**
 * 桌面悬浮球管理器
 */
export class FloatingBallManager {
  private ballWindow: BrowserWindow | null = null
  private panelWindow: BrowserWindow | null = null
  private state: FloatingBallState = 'active'
  private dragState: DragState | null = null
  private autoHideTimer: ReturnType<typeof setTimeout> | null = null
  private shortcut: string
  private shortcutRegistered = false
  private shortcutPaused = false
  private size: number
  private margin: number
  private autoHideTimeout: number
  private logger: Console

  constructor(config?: FloatingBallConfig, logger?: Console) {
    this.size = config?.size || 64
    this.margin = config?.margin || 24
    this.autoHideTimeout = config?.autoHideTimeout || 60000
    this.shortcut = config?.shortcut || 'CommandOrControl+Shift+M'
    this.logger = logger || console
  }

  /**
   * 创建悬浮球窗口
   */
  async create(): Promise<void> {
    if (this.ballWindow && !this.ballWindow.isDestroyed()) {
      return
    }

    const { workArea } = screen.getPrimaryDisplay()
    const width = this.size
    const height = this.size

    this.ballWindow = new BrowserWindow({
      width,
      height,
      minWidth: width,
      minHeight: height,
      maxWidth: width,
      maxHeight: height,
      x: workArea.x + workArea.width - width - this.margin,
      y: workArea.y + workArea.height - height - this.margin,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      title: 'mira-floating-ball',
      autoHideMenuBar: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })

    this.ballWindow.setAlwaysOnTop(true, 'floating')

    // 加载悬浮球 UI
    await this.loadBallUI()

    // 设置事件监听
    this.setupEventListeners()

    // 注册全局快捷键
    this.registerShortcut()

    // 显示悬浮球窗口
    this.ballWindow.show()
    this.ballWindow.webContents.send('floatingBall:stateChange', { state: this.state, reason: 'created' })

    this.logger.info('[FloatingBall] Created')
  }

  /**
   * 加载悬浮球 UI
   */
  private async loadBallUI(): Promise<void> {
    if (!this.ballWindow) return

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            background: transparent;
            overflow: hidden;
            user-select: none;
            -webkit-app-region: no-drag;
          }
          .ball {
            width: ${this.size}px;
            height: ${this.size}px;
            border-radius: 50%;
            background: linear-gradient(135deg, #33333d 0%, #1a1a22 100%);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.35);
            transition: transform 0.2s, box-shadow 0.2s;
          }
          .ball:hover {
            transform: scale(1.05);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
          }
          .ball:active {
            transform: scale(0.95);
          }
          .ball.listening {
            animation: pulse 1.5s infinite;
          }
          .ball.speaking {
            animation: glow 1s infinite;
          }
          @keyframes pulse {
            0%, 100% { box-shadow: 0 4px 15px rgba(14, 165, 233, 0.4); }
            50% { box-shadow: 0 4px 25px rgba(14, 165, 233, 0.8); }
          }
          @keyframes glow {
            0%, 100% { box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); }
            50% { box-shadow: 0 4px 25px rgba(16, 185, 129, 0.8); }
          }
          .logo {
            width: 32px;
            height: 32px;
            fill: white;
          }
          .tooltip {
            position: absolute;
            bottom: -30px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            white-space: nowrap;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s;
          }
          .ball:hover + .tooltip {
            opacity: 1;
          }
        </style>
      </head>
      <body>
        <div class="ball" id="ball">
          <svg class="logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
          </svg>
        </div>
        <div class="tooltip">点击展开 / ${this.shortcut}</div>
        <script>
          const ball = document.getElementById('ball');
          let isDragging = false;
          
          ball.addEventListener('mousedown', (e) => {
            isDragging = false;
            window.electronAPI?.floatingBall.dragStart({ x: e.screenX, y: e.screenY });
          });
          
          document.addEventListener('mousemove', (e) => {
            if (e.buttons === 1) {
              isDragging = true;
              window.electronAPI?.floatingBall.dragMove({ x: e.screenX, y: e.screenY });
            }
          });
          
          document.addEventListener('mouseup', () => {
            if (!isDragging) {
              window.electronAPI?.floatingBall.click();
            }
            window.electronAPI?.floatingBall.dragEnd();
            isDragging = false;
          });
          
          // 接收状态更新
          window.electronAPI?.floatingBall.onStateChange((state) => {
            ball.className = 'ball ' + state.state;
          });
        </script>
      </body>
      </html>
    `

    await this.ballWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`)
  }

  /**
   * 设置事件监听
   */
  private setupEventListeners(): void {
    if (!this.ballWindow) return

    // 拖拽事件
    ipcMain.on('floating-ball:drag-start', (event, point: { x: number; y: number }) => {
      if (event.sender !== this.ballWindow?.webContents) return
      const [windowX, windowY] = this.ballWindow.getPosition()
      this.dragState = {
        pointerX: point.x,
        pointerY: point.y,
        windowX,
        windowY,
      }
    })

    ipcMain.on('floating-ball:drag-move', (event, point: { x: number; y: number }) => {
      if (event.sender !== this.ballWindow?.webContents || !this.dragState) return
      this.ballWindow.setPosition(
        Math.round(this.dragState.windowX + point.x - this.dragState.pointerX),
        Math.round(this.dragState.windowY + point.y - this.dragState.pointerY),
      )
    })

    ipcMain.on('floating-ball:drag-end', (event) => {
      if (event.sender === this.ballWindow?.webContents) {
        this.dragState = null
      }
    })

    // 点击事件
    ipcMain.on('floating-ball:click', (event) => {
      if (event.sender === this.ballWindow?.webContents) {
        this.togglePanel()
      }
    })

    // 关闭面板事件
    ipcMain.on('floating-ball:close-panel', (event) => {
      if (event.sender === this.panelWindow?.webContents) {
        this.closePanel()
      }
    })

    // 发送消息事件
    ipcMain.on('floating-ball:send-message', (event, text: string) => {
      if (event.sender === this.panelWindow?.webContents) {
        // 这里可以集成到主 Agent 系统
        this.logger.info('[FloatingBall] Message received:', text)
        // 暂时只发送一个回复
        this.panelWindow?.webContents.send('floating-ball:message', {
          role: 'assistant',
          content: `收到消息: ${text}`,
        })
      }
    })

    // 窗口事件
    this.ballWindow.on('blur', () => {
      this.dragState = null
    })

    this.ballWindow.on('closed', () => {
      this.ballWindow = null
    })
  }

  /**
   * 切换面板
   */
  async togglePanel(): Promise<void> {
    if (this.panelWindow && !this.panelWindow.isDestroyed()) {
      this.closePanel()
    } else {
      await this.openPanel()
    }
  }

  /**
   * 打开面板
   */
  async openPanel(): Promise<void> {
    if (this.panelWindow && !this.panelWindow.isDestroyed()) {
      this.panelWindow.focus()
      return
    }

    const ballBounds = this.ballWindow?.getBounds()
    const panelWidth = 400
    const panelHeight = 600

    // 计算面板位置 (在悬浮球左侧)
    let x = (ballBounds?.x || 0) - panelWidth - 10
    let y = (ballBounds?.y || 0) + (this.size / 2) - (panelHeight / 2)

    // 边界检查
    const { workArea } = screen.getPrimaryDisplay()
    if (x < workArea.x) x = workArea.x + (ballBounds?.width || 0) + 10
    if (y < workArea.y) y = workArea.y
    if (y + panelHeight > workArea.y + workArea.height) {
      y = workArea.y + workArea.height - panelHeight
    }

    this.panelWindow = new BrowserWindow({
      width: panelWidth,
      height: panelHeight,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      hasShadow: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // 加载聊天面板
    await this.loadPanelUI()

    this.panelWindow.once('ready-to-show', () => {
      this.panelWindow?.show()
    })

    this.panelWindow.on('closed', () => {
      this.panelWindow = null
    })
  }

  /**
   * 加载面板 UI
   */
  private async loadPanelUI(): Promise<void> {
    if (!this.panelWindow) return

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: rgba(255, 255, 255, 0.95);
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
          }
          .header {
            background: #3b3b3b;
            color: white;
            padding: 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          .header h1 {
            font-size: 16px;
            font-weight: 600;
          }
          .close-btn {
            background: none;
            border: none;
            color: white;
            font-size: 20px;
            cursor: pointer;
            opacity: 0.8;
          }
          .close-btn:hover {
            opacity: 1;
          }
          .messages {
            height: calc(100% - 120px);
            overflow-y: auto;
            padding: 16px;
          }
          .input-area {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            padding: 12px 16px;
            background: white;
            border-top: 1px solid #e5e7eb;
          }
          .input-wrapper {
            display: flex;
            gap: 8px;
          }
          .input {
            flex: 1;
            padding: 10px 12px;
            border: 1px solid #d1d5db;
            border-radius: 8px;
            outline: none;
            font-size: 14px;
          }
          .input:focus {
            border-color: #3b3b3b;
          }
          .send-btn {
            padding: 10px 16px;
            background: #3b3b3b;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
          }
          .send-btn:hover {
            opacity: 0.9;
          }
          .message {
            margin-bottom: 12px;
            padding: 10px 14px;
            border-radius: 12px;
            max-width: 80%;
          }
          .message.user {
            background: #3b3b3b;
            color: white;
            margin-left: auto;
            border-bottom-right-radius: 4px;
          }
          .message.assistant {
            background: #f3f4f6;
            color: #1f2937;
            border-bottom-left-radius: 4px;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Mira</h1>
          <button class="close-btn" onclick="window.electronAPI?.floatingBall.closePanel()">&times;</button>
        </div>
        <div class="messages" id="messages">
          <div class="message assistant">你好！我是 Mira，你的 AI 助手。有什么可以帮你的吗？</div>
        </div>
        <div class="input-area">
          <div class="input-wrapper">
            <input type="text" class="input" id="input" placeholder="输入消息..." />
            <button class="send-btn" onclick="sendMessage()">发送</button>
          </div>
        </div>
        <script>
          const input = document.getElementById('input');
          const messages = document.getElementById('messages');
          
          input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
          });
          
          function sendMessage() {
            const text = input.value.trim();
            if (!text) return;
            
            addMessage('user', text);
            input.value = '';
            
            // 发送到主进程
            window.electronAPI?.floatingBall.sendMessage(text);
          }
          
          function addMessage(role, content) {
            const div = document.createElement('div');
            div.className = 'message ' + role;
            div.textContent = content;
            messages.appendChild(div);
            messages.scrollTop = messages.scrollHeight;
          }
          
          // 接收消息
          window.electronAPI?.floatingBall.onMessage((data) => {
            addMessage(data.role, data.content);
          });
        </script>
      </body>
      </html>
    `

    await this.panelWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`)
  }

  /**
   * 关闭面板
   */
  closePanel(): void {
    if (this.panelWindow && !this.panelWindow.isDestroyed()) {
      this.panelWindow.close()
    }
  }

  /**
   * 注册全局快捷键
   */
  registerShortcut(accelerator?: string): boolean {
    const key = accelerator || this.shortcut
    if (this.shortcut === key && this.shortcutRegistered) return true

    const registered = globalShortcut.register(key, () => {
      this.wake('shortcut')
    })

    if (!registered) return false

    if (this.shortcut && this.shortcut !== key) {
      globalShortcut.unregister(this.shortcut)
    }

    this.shortcut = key
    this.shortcutRegistered = true
    return true
  }

  /**
   * 暂停快捷键
   */
  pauseShortcut(): void {
    if (this.shortcut && this.shortcutRegistered) {
      globalShortcut.unregister(this.shortcut)
    }
    this.shortcutPaused = true
    this.shortcutRegistered = false
  }

  /**
   * 恢复快捷键
   */
  resumeShortcut(): boolean {
    this.shortcutPaused = false
    return this.registerShortcut(this.shortcut)
  }

  /**
   * 唤醒窗口
   */
  wake(reason: string = 'shortcut'): boolean {
    if (!this.ballWindow || this.ballWindow.isDestroyed()) return false

    if (this.ballWindow.isMinimized()) this.ballWindow.restore()
    this.ballWindow.show()
    this.ballWindow.focus()

    if (this.state === 'hidden') {
      this.setState('waking', reason)
    } else {
      this.ballWindow.webContents.send('floatingBall:stateChange', {
        state: this.state,
        reason: 'activity',
      })
    }

    return true
  }

  /**
   * 隐藏窗口
   */
  hide(reason: string = 'inactivity'): FloatingBallState {
    if (!this.ballWindow || this.ballWindow.isDestroyed() || this.state !== 'active') {
      return this.state
    }

    this.setState('hidden', reason)
    this.ballWindow.hide()
    this.logger.info('[FloatingBall] Hidden', { reason })

    return this.state
  }

  /**
   * 标记准备就绪
   */
  ready(): boolean {
    if (this.state !== 'waking') return false
    this.setState('active', 'ready')
    this.logger.info('[FloatingBall] Visible')
    return true
  }

  /**
   * 设置状态
   */
  private setState(state: FloatingBallState, reason: string): void {
    this.state = state
    this.ballWindow?.webContents.send('floatingBall:stateChange', { state, reason })
  }

  /**
   * 更新位置到屏幕角落
   */
  updatePosition(): void {
    if (!this.ballWindow || this.ballWindow.isDestroyed()) return

    const { workArea } = screen.getPrimaryDisplay()
    this.ballWindow.setPosition(
      workArea.x + workArea.width - this.size - this.margin,
      workArea.y + workArea.height - this.size - this.margin,
    )
  }

  /**
   * 启动自动隐藏定时器
   */
  startAutoHideTimer(): void {
    this.stopAutoHideTimer()
    this.autoHideTimer = setTimeout(() => {
      this.hide('inactivity')
    }, this.autoHideTimeout)
  }

  /**
   * 停止自动隐藏定时器
   */
  stopAutoHideTimer(): void {
    if (this.autoHideTimer) {
      clearTimeout(this.autoHideTimer)
      this.autoHideTimer = null
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<FloatingBallConfig>): void {
    if (config.autoHideTimeout !== undefined) {
      this.autoHideTimeout = config.autoHideTimeout
    }
    if (config.shortcut !== undefined) {
      this.registerShortcut(config.shortcut)
    }
  }

  /**
   * 销毁
   */
  destroy(): void {
    this.stopAutoHideTimer()
    globalShortcut.unregisterAll()
    this.shortcutRegistered = false
    this.shortcutPaused = false

    if (this.panelWindow && !this.panelWindow.isDestroyed()) {
      this.panelWindow.close()
    }

    if (this.ballWindow && !this.ballWindow.isDestroyed()) {
      this.ballWindow.close()
    }
  }
}

/** 全局悬浮球实例 */
let globalInstance: FloatingBallManager | null = null

/**
 * 获取全局悬浮球实例
 */
export function getFloatingBallManager(): FloatingBallManager {
  if (!globalInstance) {
    globalInstance = new FloatingBallManager()
  }
  return globalInstance
}

/**
 * 创建悬浮球管理器
 */
export function createFloatingBallManager(config?: FloatingBallConfig): FloatingBallManager {
  globalInstance = new FloatingBallManager(config)
  return globalInstance
}
