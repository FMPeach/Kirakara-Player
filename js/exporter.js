// ==================== Canvas 2D 导出流水线 ====================
// 依赖: export/container-reader.js, export/decoder-provider.js, export/renderer.js,
//        export/encoder.js, export/muxer.js, canvas-renderer.js, codec.js, muxer.js

// 极简 ZIP (STORE, 无压缩) 打包：用于 PNG 序列。PNG 本身已无损压缩，STORE
// 只做容器组装（最快）；CRC32 正确填写，保证 PR/Windows 等解压器接受。
const _crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
    return t;
})();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) { c = _crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); } return (c ^ 0xFFFFFFFF) >>> 0; }

async function buildStoreZip(entries) { // entries: [{name, blob}]
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const d = new Date(1980, 0, 1);
    const dt = { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
    for (const e of entries) {
        const nameBytes = enc.encode(e.name);
        const data = new Uint8Array(await e.blob.arrayBuffer());
        const crc = crc32(data);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);
        lh.setUint16(4, 20, true);
        lh.setUint16(6, 0x0800, true);
        lh.setUint16(8, 0, true);
        lh.setUint16(10, dt.time, true);
        lh.setUint16(12, dt.date, true);
        lh.setUint32(14, crc, true);
        lh.setUint32(18, data.length, true);
        lh.setUint32(22, data.length, true);
        lh.setUint16(26, nameBytes.length, true);
        lh.setUint16(28, 0, true);
        const lhBytes = new Uint8Array(lh.buffer);
        parts.push(lhBytes, nameBytes, data);
        central.push({ nameBytes, dataLength: data.length, crc, offset });
        offset += lhBytes.length + nameBytes.length + data.length;
    }
    const centralStart = offset;
    for (const c of central) {
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true);
        ch.setUint16(4, 20, true);
        ch.setUint16(6, 20, true);
        ch.setUint16(8, 0x0800, true);
        ch.setUint16(10, 0, true);
        ch.setUint16(12, dt.time, true);
        ch.setUint16(14, dt.date, true);
        ch.setUint32(16, c.crc, true);
        ch.setUint32(20, c.dataLength, true);
        ch.setUint32(24, c.dataLength, true);
        ch.setUint16(28, c.nameBytes.length, true);
        ch.setUint16(30, 0, true);
        ch.setUint16(32, 0, true);
        ch.setUint16(34, 0, true);
        ch.setUint16(36, 0, true);
        ch.setUint32(38, 0, true);
        ch.setUint32(42, c.offset, true);
        const chBytes = new Uint8Array(ch.buffer);
        parts.push(chBytes, c.nameBytes);
        offset += chBytes.length + c.nameBytes.length;
    }
    const centralSize = offset - centralStart;
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, centralStart, true);
    eocd.setUint16(20, 0, true);
    parts.push(new Uint8Array(eocd.buffer));
    return new Blob(parts, { type: 'application/zip' });
}

async function doExportCanvas({
    w, h, fps, expCodec, expFormat,
    duration, totalTime,
    videoUrl, bgImageEnabled, bgImageUrl,
    titleBackgroundUrl,
    audioUrl, expAudioBitrate, expAudioSampleRate, expAudioChannels,
    parsedData, config, entryBuf,
    setExpProgress, setExpEta, setExporting,
    cancelRef,
}) {
    const prependDuration = getSongTitlePrependDuration(config.songTitle);
    const outputTotalTime = totalTime + prependDuration;
    const totalFrames = Math.ceil(outputTotalTime * fps);
    const isPngSeq = expFormat === 'png-seq';

    const download = (blob, filename) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 3000);
    };

    // ---- 各层实例 ----
    let decoder = null;
    let renderer = null;
    let encoder = null;
    let hasVideo = !!videoUrl;
    let videoW = w, videoH = h;

    try {
        if (!isPngSeq && typeof VideoEncoder === 'undefined') throw new Error("浏览器不支持 WebCodecs");

        // ========== 第3层：Renderer 初始化 ==========
        renderer = KiraExport.Renderer({
            width: w, height: h,
            bgImageEnabled, bgImageUrl,
            titleBackgroundUrl,
            transparent: isPngSeq,  // PNG 序列导出：不画背景，字幕透明底
        });
        await renderer.init();

        // ========== 第1层 + 第2层：Container → Decoder ==========
        // PNG 序列模式跳过：透明底导出只画字幕/标题，不叠视频，无需解析视频流
        if (hasVideo && !isPngSeq) {
            // 尝试 Mp4Reader
            const reader = KiraExport.createContainerReader(videoUrl);
            if (reader && typeof MP4Box !== 'undefined' && typeof VideoDecoder !== 'undefined') {
                try {
                    setExpEta('解析视频流...');
                    const track = await reader.open(videoUrl, {
                        onProgress: (msg) => setExpEta(msg),
                    });
                    videoW = track.width;
                    videoH = track.height;

                    decoder = await KiraExport.createDecoder(track, { fps });
                    console.log('[Export] WebCodecs 解码器就绪: ' + track.codec);
                } catch (e) {
                    console.warn('[Export] Mp4Reader/WebCodecs 解码失败:', e.message);
                    decoder = null;  // 回退到 HtmlVideo
                }
            }

            // 回退：HtmlVideoDecoder（createDecoder 自动选择）
            if (!decoder) {
                try {
                    decoder = await KiraExport.createDecoder(videoUrl, { fps });
                    const sz = decoder.getVideoSize();
                    videoW = sz.width;
                    videoH = sz.height;
                    console.warn('[Export] <video> 就绪');
                } catch (e) {
                    console.warn('[Export] <video> 失败:', e.message);
                    hasVideo = false;
                    decoder = null;
                }
            }
        }

        // ========== 第4层：Encoder 初始化（PNG 序列模式跳过） ==========
        let actualCodec = null;
        if (!isPngSeq) {
            encoder = KiraExport.Encoder({ width: w, height: h, fps, codec: expCodec, format: expFormat });
            actualCodec = await encoder.start();
        }

        const t0 = performance.now(); let lastUp = performance.now();
        const codecLabel = isPngSeq ? 'PNG序列(透明)' : (actualCodec || expCodec);
        console.log('[Export] ' + w + 'x' + h + ' @' + fps + 'fps  ' + codecLabel + '  ' + totalFrames + 'frames  ' + (hasVideo ? 'video+' : ''));

        // ========== 渲染循环 ==========
        let firstVideoFrame = null;
        const pngBlobs = [];  // PNG 序列模式：每帧 PNG blob
        const frameDigits = Math.max(5, String(totalFrames).length);  // 帧名补零位数：默认 %05d，帧数超 99999 才扩位
        for (let i = 0; i < totalFrames; i++) {
            if (cancelRef && cancelRef.current) { console.log('[Export] 用户取消'); break; }
            const targetTime = i / fps;
            const projectTime = targetTime - prependDuration;

            // 获取视频帧
            let videoFrame = null;
            if (decoder) {
                try {
                    if (projectTime <= 0) {
                        if (!firstVideoFrame) firstVideoFrame = await decoder.getFrame(0);
                        videoFrame = firstVideoFrame;
                    } else {
                        videoFrame = await decoder.getFrame(projectTime);
                    }
                } catch (_) { }
            }

            // 渲染
            renderer.renderFrame({
                videoFrame,
                targetTime,
                projectTime,
                parsedData,
                config,
                entryBuf,
                videoW,
                videoH,
                hasVideo: !!videoFrame,
            });

            // 编码 / PNG 捕获
            const canvas = renderer.getCanvas();
            if (isPngSeq) {
                const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
                if (blob) pngBlobs.push({ name: 'frame_' + String(i).padStart(frameDigits, '0') + '.png', blob });
            } else {
                encoder.encode(canvas, targetTime, i);
                // 周期性 flush（避免编码器内存堆积）
                if ((i + 1) % (fps * 2) === 0) await encoder.flush();
            }

            // 进度更新
            const now = performance.now();
            if (now - lastUp > 200 || i === totalFrames - 1) {
                lastUp = now;
                setExpProgress(Math.round((i / totalFrames) * 100));
                const elapsed = (now - t0) / 1000;
                if (elapsed > 1 && i > 0) setExpEta(`剩~${Math.ceil((totalFrames - i) / (i / elapsed))}s`);
            }
        }

        // ========== 清理 ==========
        if (decoder) decoder.close();

        if (cancelRef && cancelRef.current) {
            if (encoder) { try { await encoder.finish(); } catch (_) { } }
            setExporting(false);
            return;
        }

        // ========== PNG 序列：打包 zip 下载 ==========
        if (isPngSeq) {
            setExpEta('导出中...');
            const zipBlob = await buildStoreZip(pngBlobs);
            download(zipBlob, `krkr-png-seq-${w}x${h}-${Date.now()}.zip`);
            console.log('[Export] PNG 序列导出完毕！');
            return;  // finally 会 setExporting(false)
        }

        // ========== 第4层 finish + 第5层 mux ==========
        setExpEta('封装中...');
        const encChunks = await encoder.finish();
        if (encChunks.length === 0) throw new Error("编码数据为空");

        // 音频管线（mp4→AAC, webm→Opus）
        let audioChunks = [];
        let audioDesc = null; // OpusHead / AAC ASC
        if (audioUrl) {
            try {
                setExpEta('编码音频...');
                const sampleRate = expAudioSampleRate || 48000;
                const channels = expAudioChannels || 2;
                const afmt = expFormat || 'webm';

                const audioEncoder = KiraExport.AudioEncoder({
                    sampleRate, channels,
                    bitrate: (expAudioBitrate || 192) * 1000,
                    format: afmt, // 'mp4'→AAC, 'webm'→Opus
                });
                await audioEncoder.start();

                // 解码完整音频
                const audioResp = await fetch(audioUrl);
                const audioBuf = await audioResp.arrayBuffer();
                const audioCtx = new OfflineAudioContext({ numberOfChannels: channels, length: Math.max(1, Math.ceil(sampleRate * totalTime)), sampleRate });
                const audioBuffer = await audioCtx.decodeAudioData(audioBuf.slice(0));

                const prependFrames = Math.round(prependDuration * sampleRate);
                const outputAudioFrames = prependFrames + audioBuffer.length;
                const FRAME_SIZE = afmt === 'mp4' ? 1024 : 960; // AAC=1024, Opus=960 (20ms@48kHz)

                // 逐帧编码：前补区写入真实静音，之后接原始音频
                for (let offset = 0; offset < outputAudioFrames; offset += FRAME_SIZE) {
                    if (cancelRef && cancelRef.current) break;
                    const framesThisChunk = Math.min(FRAME_SIZE, outputAudioFrames - offset);
                    if (framesThisChunk <= 0) break;

                    const t = offset / sampleRate;
                    const planarBuf = new ArrayBuffer(framesThisChunk * channels * 4); // f32 = 4 bytes
                    const view = new Float32Array(planarBuf);
                    for (let ch = 0; ch < channels; ch++) {
                        const sourceChannel = Math.min(ch, Math.max(0, audioBuffer.numberOfChannels - 1));
                        const chData = audioBuffer.getChannelData(sourceChannel);
                        const sourceStart = Math.max(0, offset - prependFrames);
                        const sourceEnd = Math.min(audioBuffer.length, offset + framesThisChunk - prependFrames);
                        if (sourceEnd > sourceStart) {
                            const destinationStart = Math.max(0, prependFrames - offset);
                            view.set(chData.subarray(sourceStart, sourceEnd), ch * framesThisChunk + destinationStart);
                        }
                    }

                    const audioData = new AudioData({
                        format: 'f32-planar',
                        sampleRate,
                        numberOfChannels: channels,
                        numberOfFrames: framesThisChunk,
                        timestamp: Math.round(t * 1_000_000),
                        data: planarBuf,
                    });
                    audioEncoder.encode(audioData);
                    audioData.close();
                }
                audioChunks = await audioEncoder.finish();
                audioDesc = audioEncoder.getDescription(); // OpusHead / AAC ASC
            } catch (e) {
                console.warn('[Export] 音频编码失败，导出无音频视频:', e.message);
            }
        }

        // 用编码后实际数据计算时长，避免 header Duration 与实际内容不一致导致 seek 异常
        let actualDurationMs = outputTotalTime * 1000;
        if (encChunks.length > 0) {
            const lastV = encChunks[encChunks.length - 1];
            actualDurationMs = (lastV.timestamp + Math.round(1_000_000 / fps)) / 1000;
        }
        if (audioChunks.length > 0) {
            const lastA = audioChunks[audioChunks.length - 1];
            const audioEndMs = (lastA.timestamp + (lastA.duration || 0)) / 1000;
            if (audioEndMs > actualDurationMs) actualDurationMs = audioEndMs;
        }

        const muxer = KiraExport.createMuxer(expFormat || 'webm');
        const muxOpts = {
            width: w, height: h,
            codec: actualCodec,
            durationMs: actualDurationMs,
            fps,
            avcDesc: encoder.getDescription(),  // metadata.decoderConfig.description
        };
        if (audioChunks.length > 0) {
            muxOpts.audioChunks = audioChunks;
            muxOpts.audioSampleRate = expAudioSampleRate || 48000;
            muxOpts.audioChannels = expAudioChannels || 2;
            if (audioDesc) muxOpts.audioDesc = audioDesc;
        }
        const blob = muxer.mux(encChunks, muxOpts);
        const ext = expFormat === 'mp4' ? 'mp4' : 'webm';
        download(blob, `krkr-export-${w}x${h}-${Date.now()}.${ext}`);
        console.log('[Export] 导出完毕！');

    } catch (e) {
        console.error(e);
        alert('导出异常: ' + (e.message || e));
    } finally {
        if (decoder) {
            try { decoder.close(); } catch (_) { }
        }
        setExporting(false);
    }
}
