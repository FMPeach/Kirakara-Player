// ==================== 第2层：DecoderProvider（解码提供） ====================
// 职责：输入 Track，输出 getFrame(timeSec)
// 内部维护 feedLoop / frameQueue / warmup
// 禁止渲染！
// 依赖: WebCodecs API (VideoDecoder)

var KiraExport = window.KiraExport || {};

// ============ WebCodecsDecoder ============

KiraExport.WebCodecsDecoder = function (opts) {
    opts = opts || {};
    const fps = opts.fps || 60;  // 用于 MAX_DRIFT 计算

    // ---- 内部状态 ----
    let decoder = null;
    let frameQueue = [];
    let decodeIdx = 0, decodeDone = false, feedLoopErr = null;
    let feedLoopPromise = null;
    let outputCount = 0;
    let _videoW = 1920, _videoH = 1080;  // 由 init() 设置

    // 首帧就绪通知
    let _firstFrameResolve = null;
    const firstFrameReady = new Promise(r => { _firstFrameResolve = r; });

    // 等待者队列
    const _frameWaiters = [];   // getFrameAt 等待者: { resolve }
    const _drainWaiters = [];   // feedLoop 背压等待者: resolve 函数
    const _notifyFrameWaiters = () => {
        const ws = _frameWaiters.splice(0);
        for (const w of ws) w.resolve();
    };
    const _notifyDrainWaiters = () => { const ws = _drainWaiters.splice(0); for (const w of ws) w(); };
    const _notifyAllWaiters = () => { _notifyFrameWaiters(); _notifyDrainWaiters(); };

    const FRAME_QUEUE_MAX = 150;

    // MessageChannel yield（替代 setTimeout(0)，不受后台 timer 节流）
    const _yieldToEventLoop = () => new Promise(resolve => {
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = resolve;
        port2.postMessage(null);
    });

    const MAX_DRIFT = 1.0 / fps;
    const EPS = 0.0005;

    let _lastFrameTS = -1, _reuseCount = 0;

    // ---- getFrameAt 内部逻辑 ----
    const _tryGetFrame = (targetSec) => {
        // Path A: 清理所有完全过期的帧
        let cleaned = false;
        while (frameQueue.length >= 2 && frameQueue[1].timeSec <= targetSec + EPS) {
            try { frameQueue[0].frame.close(); } catch (_) { }
            frameQueue.shift();
            cleaned = true;
        }
        if (cleaned) _notifyDrainWaiters();

        if (frameQueue.length === 0) return null;

        // Path B: 首帧已到达或超过 target → 精确匹配
        if (frameQueue[0].timeSec + EPS >= targetSec) {
            const f = frameQueue[0].frame;
            const ts = frameQueue[0].timeSec;
            if (ts === _lastFrameTS) { _reuseCount++; if (_reuseCount > 10) console.warn('[Decoder] ⚠️ 连续复用同一帧 ' + _reuseCount + ' 次  timeSec=' + ts.toFixed(4) + '  targetSec=' + targetSec.toFixed(4) + '  queue.length=' + frameQueue.length); }
            else { _reuseCount = 1; _lastFrameTS = ts; }
            return { frame: f, timeSec: ts };
        }

        // 搜索第一个 >= targetSec 的帧
        for (let fi = 0; fi < frameQueue.length; fi++) {
            if (frameQueue[fi].timeSec + EPS >= targetSec) {
                for (let dj = 0; dj < fi; dj++) try { frameQueue[dj].frame.close(); } catch (_) { }
                frameQueue.splice(0, fi);
                _notifyDrainWaiters();
                const ts = frameQueue[0].timeSec;
                return { frame: frameQueue[0].frame, timeSec: ts };
            }
        }

        // 所有帧都 < targetSec → 检查最后一帧漂移
        const lastIdx = frameQueue.length - 1;
        const lastDrift = targetSec - frameQueue[lastIdx].timeSec;

        if (lastDrift <= MAX_DRIFT || decodeDone) {
            for (let dj = 0; dj < lastIdx; dj++) try { frameQueue[dj].frame.close(); } catch (_) { }
            const lastItem = frameQueue[lastIdx];
            frameQueue.splice(0, lastIdx);
            _notifyDrainWaiters();
            return { frame: lastItem.frame, timeSec: lastItem.timeSec };
        }

        // 漂移过大且解码未完成 → 需要等待新帧
        return { needWait: true };
    };

    // ---- 公开接口 ----

    /**
     * 初始化解码器
     * @param {object} track - 来自 ContainerReader 的 track 对象
     * @returns {Promise<void>}
     */
    const init = async (track) => {
        if (typeof VideoDecoder === 'undefined') throw new Error('浏览器不支持 WebCodecs');

        _videoW = track.width;
        _videoH = track.height;

        const codec = track.codec;
        const codecDesc = track.codecDescription;
        const isHEVC = track._isHEVC;
        const isAVC = track._isAVC;
        const isVP8 = track._isVP8;
        const isVP9 = track._isVP9;
        const isAV1 = track._isAV1;

        decoder = new VideoDecoder({
            output: (vf) => {
                outputCount++;
                if (outputCount === 1) {
                    if (_firstFrameResolve) { _firstFrameResolve(); _firstFrameResolve = null; }
                }
                if (frameQueue.length >= FRAME_QUEUE_MAX * 2) {
                    try { vf.close(); } catch (_) { }
                    return;
                }
                frameQueue.push({ timeSec: vf.timestamp / 1_000_000, frame: vf });
                if (_frameWaiters.length > 0) _notifyFrameWaiters();
                if (_drainWaiters.length > 0) _notifyDrainWaiters();
            },
            error: e => {
                console.error('[Decoder] VideoDecoder error:', e);
            },
        });

        // === VideoDecoder 配置 ===
        if (isHEVC) {
            const VW = track.width;
            const VH = track.height;
            const codecStr = track.codec || track._rawCodec || "hev1.1.6.L120.90";
            // HEVC 不传 hardwareAcceleration（与 codedWidth 等字段组合会触发浏览器拒绝）

            // 步骤1：完整配置（codec + 尺寸 + description）
            const cfg = { codec: codecStr, codedWidth: VW, codedHeight: VH, description: codecDesc };
            let r = await VideoDecoder.isConfigSupported(cfg);
            console.log('[Decoder] HEVC step1 (codec+size+desc, no hw) supported =', r.supported);

            // 步骤2：如果失败，缩小到 codec + desc（不传尺寸）
            if (!r.supported) {
                console.log('[Decoder] HEVC step2 (codec+desc only)...');
                const cfg2 = { codec: codecStr, description: codecDesc };
                r = await VideoDecoder.isConfigSupported(cfg2);
                console.log('[Decoder]   supported =', r.supported);
                if (r.supported) {
                    decoder.configure(cfg2);
                }
            } else {
                decoder.configure(cfg);
            }

            if (r.supported) {
                console.log('[Decoder] VideoDecoder 就绪: ' + codecStr + ' (HEVC) state=' + decoder.state + ' decodeQueueSize=' + decoder.decodeQueueSize);
            } else {
                throw new Error("HEVC config rejected: " + codecStr);
            }
        } else if (isAVC) {
            // AVC 软解：hardwareAcceleration: 'prefer-software' 是 commit e75e5af 的修复
            const cfg = { codec: codec, codedWidth: track.width, codedHeight: track.height, hardwareAcceleration: 'prefer-software' };
            if (codecDesc) cfg.description = codecDesc;
            const r = await VideoDecoder.isConfigSupported(cfg);
            if (r.supported) {
                decoder.configure(cfg);
                console.log('[Decoder] VideoDecoder 就绪: ' + codec + ' (AVC)');
            } else {
                throw new Error("AVC config rejected: " + codec);
            }
        } else if (isVP8 || isVP9) {
            // VP8/VP9：传尺寸即可，描述可选，不传 hardwareAcceleration
            const cfg = { codec: codec, codedWidth: track.width, codedHeight: track.height };
            if (codecDesc) cfg.description = codecDesc;
            const r = await VideoDecoder.isConfigSupported(cfg);
            if (r.supported) {
                decoder.configure(cfg);
                console.log('[Decoder] VideoDecoder 就绪: ' + codec + ' (VP' + (isVP8 ? '8' : '9') + ')');
            } else {
                throw new Error("VPx config rejected: " + codec);
            }
        } else if (isAV1) {
            // AV1：需要 codecDescription（CodecPrivate），不传 hardwareAcceleration
            const cfg = { codec: codec, codedWidth: track.width, codedHeight: track.height, description: codecDesc };
            const r = await VideoDecoder.isConfigSupported(cfg);
            if (r.supported) {
                decoder.configure(cfg);
                console.log('[Decoder] VideoDecoder 就绪: ' + codec + ' (AV1)');
            } else {
                throw new Error("AV1 config rejected: " + codec);
            }
        } else {
            throw new Error('不支持的编码格式: ' + codec);
        }

        // === 启动 feedLoop ===
        const samples = track.samples;
        const feedLoop = async () => {
            try {
                const MAX_DQS = 60;
                const BATCH_MAX = 40;
                const BATCH_MIN = 3;
                while (decodeIdx < samples.length) {
                    while (frameQueue.length >= FRAME_QUEUE_MAX || decoder.decodeQueueSize >= MAX_DQS) {
                        if (decoder.decodeQueueSize >= MAX_DQS) {
                            await _yieldToEventLoop();
                        }
                        if (frameQueue.length >= FRAME_QUEUE_MAX) {
                            await new Promise(r => { _drainWaiters.push(r); });
                        }
                    }

                    const dqs = decoder.decodeQueueSize;
                    const room = MAX_DQS - dqs;
                    const dynamicBatch = Math.max(BATCH_MIN, Math.min(BATCH_MAX, room));
                    const end = Math.min(decodeIdx + dynamicBatch, samples.length);
                    for (let j = decodeIdx; j < end; j++) {
                        const s = samples[j];
                        decoder.decode(new EncodedVideoChunk({
                            type: s.isKey ? 'key' : 'delta',
                            timestamp: Math.round(s.timeSec * 1_000_000),
                            duration: Math.round(s.durationSec * 1_000_000),
                            data: s.data,
                        }));
                    }
                    decodeIdx = end;
                    await _yieldToEventLoop();
                }
                await decoder.flush();
                decodeDone = true;
                _notifyAllWaiters();
            } catch (e) { feedLoopErr = e; decodeDone = true; _notifyAllWaiters(); console.error('[Decoder] feedLoop error:', e.message || e); }
        };
        feedLoopPromise = feedLoop().catch(e => { if (!feedLoopErr) feedLoopErr = e; });

        // === Warmup: 等待首帧 ===
        const WARMUP_TIMEOUT_MS = 5000;
        let warmupOk = false;
        try {
            await Promise.race([
                firstFrameReady,
                new Promise((_, reject) => setTimeout(() => reject(new Error('warmup timeout')), WARMUP_TIMEOUT_MS))
            ]);
            warmupOk = true;
        } catch (_) {
            console.warn('[Decoder] warmup 超时，outputCount=' + outputCount + ' decodeCount=' + decodeIdx);
        }

        if (!warmupOk && frameQueue.length === 0) {
            console.warn('[Decoder] warmup 超时且无帧，init 失败');
            decoder.close();
            throw new Error('decoder warmup timeout, fallback to video seek');
        }
    };

    /**
     * 获取指定时间的解码帧
     * @param {number} targetSec - 目标时间（秒）
     * @returns {Promise<VideoFrame|null>}
     */
    const getFrame = async (targetSec) => {
        if (feedLoopErr) return null;

        // 首次尝试
        const result = _tryGetFrame(targetSec);
        if (result && !result.needWait) return result.frame;

        // === Promise 风格等待（零轮询）===
        const MAX_WAIT_MS = 60000;
        const waitStart = performance.now();

        while (true) {
            if (feedLoopErr) return null;

            if (decodeDone) {
                const retry = _tryGetFrame(targetSec);
                if (retry && !retry.needWait) return retry.frame;
                if (frameQueue.length > 0) {
                    const last = frameQueue[frameQueue.length - 1];
                    for (let dj = 0; dj < frameQueue.length - 1; dj++) try { frameQueue[dj].frame.close(); } catch (_) { }
                    frameQueue.splice(0, frameQueue.length - 1);
                    _notifyDrainWaiters();
                    return last.frame;
                }
                return null;
            }

            if (performance.now() - waitStart > MAX_WAIT_MS) {
                console.warn('[Decoder] getFrame 等待超时 ' + (MAX_WAIT_MS / 1000) + 's  target=' + targetSec.toFixed(4));
                const retry = _tryGetFrame(targetSec);
                if (retry && !retry.needWait) return retry.frame;
                if (frameQueue.length > 0) {
                    const last = frameQueue[frameQueue.length - 1];
                    for (let dj = 0; dj < frameQueue.length - 1; dj++) try { frameQueue[dj].frame.close(); } catch (_) { }
                    frameQueue.splice(0, frameQueue.length - 1);
                    _notifyDrainWaiters();
                    return last.frame;
                }
                return null;
            }

            // 等待 decoder.output 推送新帧 → Promise resolve 唤醒
            const waitEntry = {};
            const waitPromise = new Promise(r => { waitEntry.resolve = r; _frameWaiters.push(waitEntry); });
            await waitPromise;

            // 被唤醒，重新尝试
            const retry = _tryGetFrame(targetSec);
            if (retry && !retry.needWait) return retry.frame;
        }
    };

    /**
     * 获取视频原始尺寸
     */
    const getVideoSize = () => ({ width: _videoW, height: _videoH });

    /**
     * 关闭解码器，释放资源
     */
    const close = () => {
        // 等待 feedLoop 完成
        if (feedLoopPromise) {
            feedLoopPromise.catch(() => {});  // 避免未捕获的 promise rejection
        }
        if (decoder) {
            try { decoder.close(); } catch (_) { }
        }
        for (const e of frameQueue) {
            try { e.frame.close(); } catch (_) { }
        }
        frameQueue = [];
        decodeDone = true;
        _notifyAllWaiters();
    };

    return { init, getFrame, getVideoSize, close };
};

// ============ HtmlVideoDecoder（<video> 兜底） ============

KiraExport.HtmlVideoDecoder = function (opts) {
    opts = opts || {};
    let videoEl = null;
    let hasVideo = true;
    let _videoW = 1920, _videoH = 1080;

    const init = async (url) => {
        if (!url || typeof url !== 'string') throw new Error('HtmlVideoDecoder 需要 video URL');

        videoEl = document.createElement('video');
        videoEl.src = url;
        videoEl.muted = true;
        videoEl.crossOrigin = 'anonymous';
        videoEl.preload = 'auto';

        await new Promise((resolve) => {
            const t = setTimeout(() => resolve(), 8000);
            videoEl.addEventListener('loadeddata', () => { clearTimeout(t); resolve(); }, { once: true });
            videoEl.addEventListener('error', () => { clearTimeout(t); resolve(); }, { once: true });
            if (videoEl.readyState >= 2) { clearTimeout(t); resolve(); }
        });

        if (videoEl.readyState < 2) {
            hasVideo = false;
            videoEl = null;
            throw new Error('video 加载失败');
        }

        _videoW = videoEl.videoWidth || 1920;
        _videoH = videoEl.videoHeight || 1080;
    };

    const getFrame = async (targetSec) => {
        if (!videoEl || !hasVideo) return null;
        if (targetSec > (videoEl.duration || Infinity)) return null;

        videoEl.currentTime = targetSec;
        await new Promise(resolve => {
            const onS = () => { videoEl.removeEventListener('seeked', onS); resolve(); };
            videoEl.addEventListener('seeked', onS);
        });
        return videoEl;  // 返回 video 元素本身（由 renderer 用 drawImage 绘制）
    };

    const getVideoSize = () => ({
        width: videoEl ? (videoEl.videoWidth || _videoW) : _videoW,
        height: videoEl ? (videoEl.videoHeight || _videoH) : _videoH,
    });

    const close = () => {
        if (videoEl) {
            try { videoEl.pause(); } catch (_) { }
            videoEl = null;
        }
    };

    return { init, getFrame, getVideoSize, close, isHtmlVideo: true };
};

// ============ 便捷工厂 ============

/**
 * 根据 track/url 自动选择并初始化解码器（一步到位）
 * @param {object|string} trackOrUrl - Mp4Reader 返回的 track 对象，或视频 URL 字符串
 * @param {object} opts - 选项 { fps }
 * @returns {Promise<object>} 已初始化的解码器 { getFrame, getVideoSize, close }
 */
KiraExport.createDecoder = async function (trackOrUrl, opts) {
    // 有 samples 的 track 对象 → WebCodecs 路径
    if (trackOrUrl && typeof trackOrUrl === 'object' && Array.isArray(trackOrUrl.samples) && trackOrUrl.samples.length > 0) {
        const decoder = KiraExport.WebCodecsDecoder(opts);
        await decoder.init(trackOrUrl);
        return decoder;
    }
    // 字符串 URL 或 无 samples → HtmlVideo 兜底
    const decoder = KiraExport.HtmlVideoDecoder(opts);
    const url = typeof trackOrUrl === 'string' ? trackOrUrl : (trackOrUrl && trackOrUrl._videoUrl);
    await decoder.init(url);
    return decoder;
};
