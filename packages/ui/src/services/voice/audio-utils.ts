/**
 * 音频工具 — Float32Array ↔ AudioBuffer、录音、播放
 *
 * transformers.js 的 TTS 输出 `{ audio: Float32Array, sampling_rate }`，
 * 这里负责转成 Web Audio 可播放的 AudioBuffer；STT 需要录音时负责采集。
 */

/** 把 Float32Array + 采样率写入 AudioBuffer（供 AudioBufferSourceNode 播放） */
export function float32ToAudioBuffer(
  ctx: AudioContext,
  audio: Float32Array,
  sampleRate: number,
): AudioBuffer {
  const buffer = ctx.createBuffer(1, audio.length, sampleRate)
  buffer.copyToChannel(audio, 0)
  return buffer
}

/** 播放一段 Float32Array 音频；resolve 在播放结束或 stop() 时 */
export function playFloat32(
  ctx: AudioContext,
  audio: Float32Array,
  sampleRate: number,
): { node: AudioBufferSourceNode; promise: Promise<void> } {
  const buffer = float32ToAudioBuffer(ctx, audio, sampleRate)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start()

  const promise = new Promise<void>((resolve) => {
    source.onended = () => resolve()
  })
  return { node: source, promise }
}

/** 启动麦克风录音；resolve 时返回 AudioContext + Analyser + MediaStreamSource（用于 VAD） */
export async function startMicRecording(): Promise<{
  ctx: AudioContext
  stream: MediaStream
  analyser: AnalyserNode
  sourceNode: MediaStreamAudioSourceNode
}> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const ctx = new AudioContext()
  const sourceNode = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  sourceNode.connect(analyser)
  return { ctx, stream, analyser, sourceNode }
}

/** 读取当前 RMS 音量（0-1），供 VAD 能量检测使用 */
export function getCurrentVolume(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(data)
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / data.length)
}

/** 采集一段麦克风音频为 Float32Array（供本地 Whisper 识别），采样率重采样到 16k */
export function recordChunk(
  ctx: AudioContext,
  stream: MediaStream,
  sampleRate = 16000,
  onChunk: (audio: Float32Array) => void,
): { stop: () => void } {
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  source.connect(processor)
  processor.connect(ctx.destination)

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0)
    // 重采样（当前采样率 → 目标 16k）
    if (ctx.sampleRate === sampleRate) {
      onChunk(new Float32Array(input))
    } else {
      const ratio = sampleRate / ctx.sampleRate
      const newLen = Math.floor(input.length * ratio)
      const out = new Float32Array(newLen)
      for (let i = 0; i < newLen; i++) {
        const idx = Math.floor(i / ratio)
        out[i] = input[Math.min(idx, input.length - 1)]
      }
      onChunk(out)
    }
  }

  return {
    stop: () => {
      source.disconnect()
      processor.disconnect()
    },
  }
}

/** 合并多个 16k 音频块为一个 Float32Array */
export function mergeChunks(chunks: Float32Array[], sampleRate: number): Float32Array {
  if (chunks.length === 0) return new Float32Array(0)
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  void sampleRate
  return out
}
