// ==================== Canvas 2D 导出流水线 ====================
// 依赖: canvas-renderer.js, muxer.js, codec.js, shared/*

async function doExportCanvas({
    w, h, fps, expCodec,
    duration, totalTime,
    videoUrl, bgImageEnabled, bgImageUrl,
    parsedData, config, entryBuf,
    setExpProgress, setExpEta, setExporting,
    cancelRef,
}) {
    const totalFrames = Math.ceil(totalTime * fps);

    const download = (blob, filename) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 3000);
    };

    try {
        if (typeof VideoEncoder === 'undefined') throw new Error("浏览器不支持 WebCodecs");

        const offCanvas = document.createElement('canvas');
        offCanvas.width = w; offCanvas.height = h;
        const octx = offCanvas.getContext('2d', { willReadFrequently: true });

        let bgImgObj = null;
        if (bgImageEnabled && bgImageUrl) {
            bgImgObj = new Image();
            bgImgObj.src = bgImageUrl;
            await new Promise(r => { bgImgObj.onload = r; bgImgObj.onerror = r; });
        }

        let hasVideo = !!videoUrl;

        // === mp4box + VideoDecoder 帧提取器 ===
        let frameProvider = null;
        let videoW = w, videoH = h;  // 视频原始尺寸，默认等于画布

        if (hasVideo && typeof MP4Box !== 'undefined' && typeof VideoDecoder !== 'undefined') {
            try {
                setExpEta('解析视频流...');
                const resp = await fetch(videoUrl);
                const buf = await resp.arrayBuffer();
                const file = MP4Box.createFile();
                const samples = [];
                let trackInfo = null;

                await new Promise((resolve, reject) => {
                    file.onReady = (info) => {
                        trackInfo = info.videoTracks[0];
                        if (!trackInfo) { reject(new Error('无视频轨道')); return; }
                        videoW = trackInfo.track_width || trackInfo.video.width;
                        videoH = trackInfo.track_height || trackInfo.video.height;
                        file.setExtractionOptions(trackInfo.id);
                        file.onSamples = (_id, _user, s) => {
                            for (const sample of s) {
                                samples.push({
                                    timeSec: sample.cts / sample.timescale,
                                    dtsSec: (sample.dts !== undefined ? sample.dts : sample.cts) / sample.timescale,
                                    isKey: sample.is_sync,
                                    data: new Uint8Array(sample.data),
                                    durationSec: sample.duration / sample.timescale,
                                });
                            }
                        };
                        file.start();
                    };
                    file.onError = (e) => { reject(e); };
                    buf.fileStart = 0;
                    file.appendBuffer(buf);
                    file.flush();
                    setTimeout(() => {
                        if (samples.length > 0) resolve();
                        else reject(new Error('mp4box 未提取到任何样本'));
                    }, 1000);
                });
                // mp4box parsed

                // === avcC 提取（从 mp4box internalTrack.stsd） ===
                let codecDesc = null;
                try {
                    const internalTrack = file.getTrackById(trackInfo.id);
                    const stsd = internalTrack?.mdia?.minf?.stbl?.stsd;
                    if (stsd?.entries?.[0]?.avcC) {
                        const box = stsd.entries[0].avcC;
                        if (box.configurationVersion !== undefined) {
                            // 手动序列化 AVCDecoderConfigurationRecord
                            const toU8 = (src) => {
                                if (!src && src !== 0) return null;
                                if (src instanceof Uint8Array) return src;
                                if (src instanceof ArrayBuffer) return new Uint8Array(src);
                                if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset || 0, src.byteLength || src.length);
                                if (typeof src.length === 'number') { const arr = new Uint8Array(src.length); for (let i = 0; i < src.length; i++) arr[i] = (typeof src[i] === 'number' ? src[i] : 0) & 0xff; return arr; }
                                return null;
                            };
                            const getNAL = (field) => {
                                if (!field) return [];
                                if (Array.isArray(field)) return field.map(n => {
                                    if (n instanceof Uint8Array || ArrayBuffer.isView(n)) return toU8(n);
                                    if (n && n.nalu) return toU8(n.nalu); if (n && n.data) return toU8(n.data);
                                    if (typeof n.length === 'number') return toU8(n);
                                    return null;
                                }).filter(Boolean);
                                const s = toU8(field); if (s && s.length >= 4) return [s];
                                if (typeof field.length === 'number' && field.length > 0) { const a = toU8(field); if (a && a.length >= 4) return [a]; }
                                return [];
                            };
                            const sl = getNAL(box.SPS), pl = getNAL(box.PPS);
                            if (sl.length > 0 && pl.length > 0) {
                                let total = 7;
                                for (const s of sl) total += 2 + s.length;
                                total += 1;
                                for (const p of pl) total += 2 + p.length;
                                codecDesc = new Uint8Array(total);
                                let off = 0;
                                codecDesc[off++] = box.configurationVersion || 1;
                                codecDesc[off++] = box.AVCProfileIndication || 66;
                                codecDesc[off++] = box.profile_compatibility || 0;
                                codecDesc[off++] = box.AVCLevelIndication || 40;
                                codecDesc[off++] = ((box.lengthSizeMinusOne || 3) & 0x03) | 0xFC;
                                codecDesc[off++] = (sl.length & 0x1F) | 0xE0;
                                for (const s of sl) { codecDesc[off++] = (s.length >> 8) & 0xFF; codecDesc[off++] = s.length & 0xFF; codecDesc.set(s, off); off += s.length; }
                                codecDesc[off++] = pl.length & 0xFF;
                                for (const p of pl) { codecDesc[off++] = (p.length >> 8) & 0xFF; codecDesc[off++] = p.length & 0xFF; codecDesc.set(p, off); off += p.length; }
                                // codecDesc built
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[Export] avcC 提取失败:', e.message);
                }

                const rawCodec = trackInfo.codec || '';
                const isAVC1 = rawCodec.startsWith('avc1');
                if (isAVC1 && !codecDesc) throw new Error(rawCodec + ' 缺少 codec description');

                // === VideoDecoder + 双背压流水线 ===
                const FRAME_QUEUE_MAX = 150;
                const frameQueue = [];
                let decodeIdx = 0, decodeDone = false, feedLoopErr = null;

                // === 异步背压通知器===
                const _frameWaiters = [];   // getFrameAt 等待者: { resolve }
                const _drainWaiters = [];   // feedLoop 背压等待者: resolve 函数
                const _notifyFrameWaiters = () => {
                    const ws = _frameWaiters.splice(0);
                    for (const w of ws) w.resolve();
                };
                const _notifyDrainWaiters = () => { const ws = _drainWaiters.splice(0); for (const w of ws) w(); };
                const _notifyAllWaiters = () => { _notifyFrameWaiters(); _notifyDrainWaiters(); };

                const decoder = new VideoDecoder({
                    output: (vf) => {
                        if (frameQueue.length >= FRAME_QUEUE_MAX * 2) {
                            try { vf.close(); } catch (_) {}
                            return;
                        }
                        frameQueue.push({ timeSec: vf.timestamp / 1_000_000, frame: vf });
                        if (_frameWaiters.length > 0) _notifyFrameWaiters();
                        if (_drainWaiters.length > 0) _notifyDrainWaiters();
                    },
                    error: e => {
                        console.error('[Export] VideoDecoder error:', e);
                    },
                });

                const decoderConfig = { codec: rawCodec || 'avc1.42001f', codedWidth: trackInfo.video.width, codedHeight: trackInfo.video.height, hardwareAcceleration: 'prefer-software' };
                if (codecDesc) decoderConfig.description = codecDesc;
                decoder.configure(decoderConfig);

                // === MessageChannel yield（替代 setTimeout(0)，不受后台 timer 节流）===
                const _yieldToEventLoop = () => new Promise(resolve => {
                    const { port1, port2 } = new MessageChannel();
                    port1.onmessage = resolve;
                    port2.postMessage(null);
                });

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
                    } catch (e) { feedLoopErr = e; decodeDone = true; _notifyAllWaiters(); console.error('[Export] feedLoop error:', e.message || e); }
                };
                feedLoop();

                const EPS = 0.0005;
                const MAX_DRIFT = 1.0 / fps;
                let _lastFrameTS = -1, _reuseCount = 0;

                const getFrameAt = async (targetSec) => {
                    if (feedLoopErr) return null;

                    // === 内部函数：清理过期帧并查找最佳匹配 ===
                    // 返回 { frame, timeSec } 或 { needWait: true } 或 null
                    const _tryGetFrame = () => {
                        // Path A: 清理所有完全过期的帧
                        let cleaned = false;
                        while (frameQueue.length >= 2 && frameQueue[1].timeSec <= targetSec + EPS) {
                            try { frameQueue[0].frame.close(); } catch (_) {}
                            frameQueue.shift();
                            cleaned = true;
                        }
                        if (cleaned) _notifyDrainWaiters();

                        if (frameQueue.length === 0) return null;

                        // Path B: 首帧已到达或超过 target → 精确匹配
                        if (frameQueue[0].timeSec + EPS >= targetSec) {
                            const f = frameQueue[0].frame;
                            const ts = frameQueue[0].timeSec;
                            if (ts === _lastFrameTS) { _reuseCount++; if (_reuseCount > 10) console.warn('[Export] ⚠️ 连续复用同一帧 ' + _reuseCount + ' 次  timeSec=' + ts.toFixed(4) + '  targetSec=' + targetSec.toFixed(4) + '  queue.length=' + frameQueue.length); }
                            else { _reuseCount = 1; _lastFrameTS = ts; }
                            return { frame: f, timeSec: ts };
                        }

                        // 搜索第一个 >= targetSec 的帧
                        for (let fi = 0; fi < frameQueue.length; fi++) {
                            if (frameQueue[fi].timeSec + EPS >= targetSec) {
                                for (let dj = 0; dj < fi; dj++) try { frameQueue[dj].frame.close(); } catch (_) {}
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
                            for (let dj = 0; dj < lastIdx; dj++) try { frameQueue[dj].frame.close(); } catch (_) {}
                            const lastItem = frameQueue[lastIdx];
                            frameQueue.splice(0, lastIdx);
                            _notifyDrainWaiters();
                            return { frame: lastItem.frame, timeSec: lastItem.timeSec };
                        }

                        // 漂移过大且解码未完成 → 需要等待新帧
                        return { needWait: true };
                    };

                    // 首次尝试
                    const result = _tryGetFrame();
                    if (result && !result.needWait) return result.frame;

                    // === Promise 风格等待（零轮询）===
                    const MAX_WAIT_MS = 60000;
                    const waitStart = performance.now();

                    while (true) {
                        if (feedLoopErr) return null;

                        if (decodeDone) {
                            const retry = _tryGetFrame();
                            if (retry && !retry.needWait) return retry.frame;
                            if (frameQueue.length > 0) {
                                const last = frameQueue[frameQueue.length - 1];
                                for (let dj = 0; dj < frameQueue.length - 1; dj++) try { frameQueue[dj].frame.close(); } catch (_) {}
                                frameQueue.splice(0, frameQueue.length - 1);
                                _notifyDrainWaiters();
                                return last.frame;
                            }
                            return null;
                        }

                        if (performance.now() - waitStart > MAX_WAIT_MS) {
                            console.warn('[Export] getFrameAt 等待超时 ' + (MAX_WAIT_MS / 1000) + 's  target=' + targetSec.toFixed(4));
                            const retry = _tryGetFrame();
                            if (retry && !retry.needWait) return retry.frame;
                            if (frameQueue.length > 0) {
                                const last = frameQueue[frameQueue.length - 1];
                                for (let dj = 0; dj < frameQueue.length - 1; dj++) try { frameQueue[dj].frame.close(); } catch (_) {}
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
                        const retry = _tryGetFrame();
                        if (retry && !retry.needWait) return retry.frame;
                    }
                };

                const warmupStart = performance.now();
                const WARMUP_TIMEOUT_MS = 30000;
                while (frameQueue.length < 30 && !decodeDone) {
                    if (performance.now() - warmupStart > WARMUP_TIMEOUT_MS) {
                        console.warn('[Export] decoder warmup 超时 ' + (WARMUP_TIMEOUT_MS / 1000) + 's，回退 <video> 方案');
                        decoder.close();
                        throw new Error('decoder warmup timeout, fallback to video seek');
                    }
                    await new Promise(r => setTimeout(r, 50));
                }

                frameProvider = { getFrame: getFrameAt, close: () => { decoder.close(); for (const e of frameQueue) e.frame.close(); } };
            } catch (e) {
                console.warn('[Export] mp4box 路径失败，回退 <video>:', e.message);
            }
        } else {
            // mp4box 或 VideoDecoder 不可用，跳过
        }

        // === <video> 兜底 ===
        let exportVideoEl = (!frameProvider && hasVideo) ? document.createElement('video') : null;
        if (exportVideoEl) {
            exportVideoEl.src = videoUrl; exportVideoEl.muted = true; exportVideoEl.crossOrigin = 'anonymous'; exportVideoEl.preload = 'auto';
            await new Promise((resolve) => {
                const t = setTimeout(() => resolve(), 8000);
                exportVideoEl.addEventListener('loadeddata', () => { clearTimeout(t); resolve(); }, { once: true });
                exportVideoEl.addEventListener('error', () => { clearTimeout(t); resolve(); }, { once: true });
                if (exportVideoEl.readyState >= 2) { clearTimeout(t); resolve(); }
            });
            if (exportVideoEl.readyState < 2) { hasVideo = false; exportVideoEl = null; }
        }
        if (!frameProvider && !exportVideoEl) {
            hasVideo = false;
        }

        // === 编码器 ===
        const codecStr = expCodec === 'vp8' ? 'vp8' : expCodec === 'h264' ? 'avc1.42001f' : getVP9CodecString(w, h, fps);
        const encChunks = []; let encError = null;
        const encoder = new VideoEncoder({
            output: chunk => { const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf); encChunks.push({ data: buf, timestamp: chunk.timestamp, isKey: chunk.type === 'key' }); },
            error: e => { encError = e; console.error(e); },
        });
        const actualCodec = await configureVideoEncoder(encoder, codecStr, w, h, fps);

        const t0 = performance.now(); let lastUp = performance.now();
        const codecLabel = actualCodec || codecStr;
        console.log('[Export] ' + w + 'x' + h + ' @' + fps + 'fps  ' + codecLabel + '  ' + totalFrames + 'frames  ' + (hasVideo ? 'video+' : ''));

        // === 渲染循环 ===
        for (let i = 0; i < totalFrames; i++) {
            if (cancelRef && cancelRef.current) { console.log('[Export] 用户取消'); break; }
            if (encError) throw encError;
            const targetTime = i / fps;

            let decodedVf = null;
            if (frameProvider) {
                try { decodedVf = await frameProvider.getFrame(targetTime); } catch (_) {}
            } else if (exportVideoEl && targetTime <= (exportVideoEl.duration || Infinity)) {
                exportVideoEl.currentTime = targetTime;
                await new Promise(resolve => { const onS = () => { exportVideoEl.removeEventListener('seeked', onS); resolve(); }; exportVideoEl.addEventListener('seeked', onS); });
            }

            octx.clearRect(0, 0, w, h);

            // 背景填充（视频有黑边 / 背景图 / 背景色）
            if (decodedVf || (exportVideoEl && exportVideoEl.readyState >= 2)) {
                octx.fillStyle = '#000';
                octx.fillRect(0, 0, w, h);
            } else if (bgImgObj && bgImgObj.complete && bgImgObj.naturalWidth > 0) {
                octx.save(); octx.filter = 'blur(20px) brightness(0.4)'; octx.drawImage(bgImgObj, 0, 0, w, h); octx.restore();
                octx.save(); octx.globalAlpha = config.bgImageOpacity ?? 1;
                const sbg = Math.min(w / bgImgObj.naturalWidth, h / bgImgObj.naturalHeight);
                octx.drawImage(bgImgObj, (w - bgImgObj.naturalWidth * sbg) / 2, (h - bgImgObj.naturalHeight * sbg) / 2, bgImgObj.naturalWidth * sbg, bgImgObj.naturalHeight * sbg);
                octx.restore();
            } else {
                octx.fillStyle = config.bgColor || '#000';
                octx.fillRect(0, 0, w, h);
            }

            // 视频帧：letterbox 保持宽高比（与 DOM object-fit:contain 一致）
            if (decodedVf) {
                const scale = Math.min(w / videoW, h / videoH);
                const dw = videoW * scale, dh = videoH * scale;
                octx.drawImage(decodedVf, (w - dw) / 2, (h - dh) / 2, dw, dh);
            } else if (exportVideoEl && exportVideoEl.readyState >= 2) {
                const evw = exportVideoEl.videoWidth || videoW;
                const evh = exportVideoEl.videoHeight || videoH;
                const scale = Math.min(w / evw, h / evh);
                const dw = evw * scale, dh = evh * scale;
                octx.drawImage(exportVideoEl, (w - dw) / 2, (h - dh) / 2, dw, dh);
            }

            octx.save(); octx.scale(w / 1280, h / 720);
            drawLyricsOnCanvas(octx, parsedData, targetTime, config, entryBuf);
            octx.restore();

            const vf = new VideoFrame(offCanvas, { timestamp: Math.round(targetTime * 1_000_000), duration: Math.round(1_000_000 / fps) });
            encoder.encode(vf, { keyFrame: (i % fps === 0) }); vf.close();
            if ((i + 1) % (fps * 2) === 0) await encoder.flush();

            const now = performance.now();
            if (now - lastUp > 200 || i === totalFrames - 1) {
                lastUp = now; setExpProgress(Math.round((i / totalFrames) * 100));
                const elapsed = (now - t0) / 1000;
                if (elapsed > 1 && i > 0) setExpEta(`剩~${Math.ceil((totalFrames - i) / (i / elapsed))}s`);
            }
        }

        if (hasVideo && exportVideoEl) exportVideoEl.pause();
        if (frameProvider) frameProvider.close();

        if (cancelRef && cancelRef.current) { encoder.close(); setExporting(false); return; }

        setExpEta('封装中...');
        await encoder.flush(); encoder.close();
        if (encChunks.length === 0) throw new Error("编码数据为空");

        const webmBlob = muxWebM(encChunks, { width: w, height: h, codec: codecToMuxLabel(actualCodec), durationMs: totalTime * 1000 });
        download(webmBlob, `krkr-export-${w}x${h}-${Date.now()}.webm`);
        console.log('[Export] ' + '导出完毕！');

    } catch (e) {
        console.error(e);
        alert('导出异常: ' + (e.message || e));
    } finally {
        setExporting(false);
    }
}
