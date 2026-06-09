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
                        file.setExtractionOptions(trackInfo.id);
                        file.onSamples = (_id, _user, s) => {
                            for (const sample of s) {
                                samples.push({
                                    timeSec: sample.cts / sample.timescale,
                                    isKey: sample.is_sync,
                                    data: new Uint8Array(sample.data),
                                    durationSec: sample.duration / sample.timescale,
                                });
                            }
                        };
                        file.start();
                    };
                    file.onError = reject;
                    buf.fileStart = 0;
                    file.appendBuffer(buf);
                    file.flush();
                    setTimeout(() => {
                        if (samples.length > 0) resolve();
                        else reject(new Error('mp4box 未提取到任何样本'));
                    }, 1000);
                });

                console.log('[Export] mp4box 解析:', samples.length, 'samples,', trackInfo.codec, trackInfo.video.width + 'x' + trackInfo.video.height);

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
                                console.log('[Export] avcC 序列化:', codecDesc.length, 'B');
                            }
                        }
                    }
                } catch (e) { console.warn('[Export] avcC 提取失败:', e.message); }

                const rawCodec = trackInfo.codec || '';
                const isAVC1 = rawCodec.startsWith('avc1');
                if (isAVC1 && !codecDesc) throw new Error(rawCodec + ' 缺少 codec description');

                // === VideoDecoder + 生产者-消费者流水线 ===
                const FRAME_QUEUE_MAX = 150;
                const frameQueue = [];
                let decodeIdx = 0, decodeDone = false, feedLoopErr = null;

                const decoder = new VideoDecoder({
                    output: (vf) => { frameQueue.push({ timeSec: vf.timestamp / 1_000_000, frame: vf }); },
                    error: e => console.error('[Export] VideoDecoder error:', e),
                });
                const decoderConfig = { codec: rawCodec || 'avc1.42001f', codedWidth: trackInfo.video.width, codedHeight: trackInfo.video.height };
                if (codecDesc) decoderConfig.description = codecDesc;
                decoder.configure(decoderConfig);
                console.log('[Export] VideoDecoder 配置:', decoderConfig.codec, 'desc=' + (codecDesc ? codecDesc.length + 'B' : '无'));

                const feedLoop = async () => {
                    try {
                        const BATCH = 10;
                        while (decodeIdx < samples.length) {
                            while (frameQueue.length >= FRAME_QUEUE_MAX) await new Promise(r => setTimeout(r, 5));
                            const end = Math.min(decodeIdx + BATCH, samples.length);
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
                            await new Promise(r => setTimeout(r, 0));
                        }
                        await decoder.flush();
                        decodeDone = true;
                    } catch (e) { feedLoopErr = e; decodeDone = true; console.error('[Export] feedLoop 异常:', e); }
                };
                feedLoop();

                const EPS = 0.0005;
                const getFrameAt = async (targetSec) => {
                    if (feedLoopErr) return null;
                    while (frameQueue.length >= 2 && frameQueue[1].timeSec <= targetSec + EPS) {
                        try { frameQueue[0].frame.close(); } catch (_) {}
                        frameQueue.shift();
                    }
                    if (frameQueue.length > 0 && frameQueue[0].timeSec + EPS >= targetSec) return frameQueue[0].frame;
                    if (frameQueue.length >= 2 && frameQueue[0].timeSec + EPS < targetSec) {
                        try { frameQueue[0].frame.close(); } catch (_) {}
                        frameQueue.shift();
                        return frameQueue[0].frame;
                    }
                    if (frameQueue.length === 1 && frameQueue[0].timeSec + EPS < targetSec) return frameQueue[0].frame;
                    let waitStart = performance.now();
                    while (frameQueue.length === 0) {
                        if (decodeDone || feedLoopErr) break;
                        if (performance.now() - waitStart > 15000) break;
                        await new Promise(r => setTimeout(r, 50));
                    }
                    if (feedLoopErr) return null;
                    if (frameQueue.length > 0) {
                        for (let fi = 0; fi < frameQueue.length; fi++) {
                            if (frameQueue[fi].timeSec + EPS >= targetSec) {
                                for (let dj = 0; dj < fi; dj++) try { frameQueue[dj].frame.close(); } catch (_) {}
                                frameQueue.splice(0, fi);
                                return frameQueue[0].frame;
                            }
                        }
                        const lastIdx = frameQueue.length - 1;
                        for (let dj = 0; dj < lastIdx; dj++) try { frameQueue[dj].frame.close(); } catch (_) {}
                        const last = frameQueue[lastIdx];
                        frameQueue.splice(0, lastIdx);
                        return last.frame;
                    }
                    return null;
                };

                while (frameQueue.length < 30 && !decodeDone) await new Promise(r => setTimeout(r, 50));

                frameProvider = { getFrame: getFrameAt, close: () => { decoder.close(); for (const e of frameQueue) e.frame.close(); } };
            } catch (e) {
                console.warn('[Export] mp4box 路径失败，回退 <video>:', e.message);
            }
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
        if (!frameProvider && !exportVideoEl) hasVideo = false;

        // === 编码器 ===
        const codecStr = expCodec === 'vp8' ? 'vp8' : expCodec === 'h264' ? 'avc1.42001f' : getVP9CodecString(w, h, fps);
        const encChunks = []; let encError = null;
        const encoder = new VideoEncoder({
            output: chunk => { const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf); encChunks.push({ data: buf, timestamp: chunk.timestamp, isKey: chunk.type === 'key' }); },
            error: e => { encError = e; console.error(e); },
        });
        const actualCodec = await configureVideoEncoder(encoder, codecStr, w, h, fps, console.log);

        const t0 = performance.now(); let lastUp = performance.now();
        console.log('[Export] 开始导出:', parsedData.length + '条歌词', w + 'x' + h + '@' + fps, 'hasVideo=' + hasVideo, 'provider=' + (frameProvider ? 'mp4box' : exportVideoEl ? 'video' : 'none'));

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
            if (decodedVf) { octx.drawImage(decodedVf, 0, 0, w, h); }
            else if (exportVideoEl && exportVideoEl.readyState >= 2) { octx.drawImage(exportVideoEl, 0, 0, w, h); }
            else if (bgImgObj && bgImgObj.complete && bgImgObj.naturalWidth > 0) {
                octx.save(); octx.filter = 'blur(20px) brightness(0.4)'; octx.drawImage(bgImgObj, 0, 0, w, h); octx.restore();
                octx.save(); octx.globalAlpha = config.bgImageOpacity ?? 1;
                const s = Math.min(w / bgImgObj.naturalWidth, h / bgImgObj.naturalHeight);
                octx.drawImage(bgImgObj, (w - bgImgObj.naturalWidth * s) / 2, (h - bgImgObj.naturalHeight * s) / 2, bgImgObj.naturalWidth * s, bgImgObj.naturalHeight * s);
                octx.restore();
            } else { octx.fillStyle = config.bgColor || '#000'; octx.fillRect(0, 0, w, h); }

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

    } catch (e) {
        console.error(e);
        alert('导出异常: ' + (e.message || e));
    } finally {
        setExporting(false);
    }
}
