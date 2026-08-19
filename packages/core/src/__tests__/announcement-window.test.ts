import { describe, it, expect } from "vitest"
import { AnnouncementWindow } from "../voice/announcement-window"

describe("AnnouncementWindow", () => {
  it("初始状态：无阻塞，可播报", () => {
    const w = new AnnouncementWindow()
    expect(w.isBlocked()).toBe(false)
  })

  it("用户回合中阻塞播报；回合结算后解除", () => {
    const w = new AnnouncementWindow()
    w.beginTurn("t1")
    expect(w.isBlocked()).toBe(true)
    w.endSpeech()
    // 用户停止说话但本回合尚未结算，仍处防护状态
    expect(w.isBlocked()).toBe(true)
    w.responseDone({ turnId: "t1" })
    expect(w.isBlocked()).toBe(false)
  })

  it("pending turn 未结算时阻塞；模型响应完成解除", () => {
    const w = new AnnouncementWindow()
    w.beginTurn("t1")
    w.endSpeech()
    w.responseDone({ turnId: "t1", hasAudio: false, hasFunctionCall: false })
    expect(w.isBlocked()).toBe(false)
  })

  it("待播音频仍在队列时阻塞，播放结束解除", () => {
    const w = new AnnouncementWindow()
    w.beginTurn("t1")
    w.endSpeech()
    w.responseDone({ turnId: "t1" }) // 纯文本回合已结算
    w.queueAudio("r1", { turnId: "t1" })
    expect(w.isBlocked()).toBe(true)
    w.startPlayback("r1")
    expect(w.isPlaying()).toBe(true)
    w.finishPlayback("r1")
    expect(w.isBlocked()).toBe(false)
    expect(w.isPlaying()).toBe(false)
  })

  it("公告（announcement）响应永远不会清掉 turn pending", () => {
    const w = new AnnouncementWindow()
    w.beginTurn("t1")
    w.responseDone({ turnId: "t1", origin: "announcement" })
    expect(w.isBlocked()).toBe(true)
  })

  it("其他 turn 的响应不影响当前 pending", () => {
    const w = new AnnouncementWindow()
    w.beginTurn("t1")
    w.responseDone({ turnId: "t99" })
    expect(w.isBlocked()).toBe(true)
  })

  it("用户打断解除 pending", () => {
    const w = new AnnouncementWindow()
    w.beginTurn("t1")
    w.endSpeech()
    expect(w.isBlocked()).toBe(true)
    w.interrupt()
    expect(w.isBlocked()).toBe(false)
  })

  it("reset 清理全部状态", () => {
    const w = new AnnouncementWindow()
    w.beginTurn("t1")
    w.queueAudio("r1")
    w.startPlayback("r1")
    w.reset()
    expect(w.isBlocked()).toBe(false)
    expect(w.isPlaying()).toBe(false)
  })
})