// ==================== Canvas 2D 导出流水线 ====================
// 依赖: export/container-reader.js, export/decoder-provider.js, export/renderer.js,
//        export/encoder.js, export/muxer.js, canvas-renderer.js, codec.js, muxer.js

async function doExportCanvas({
    w, h, fps, expCodec, expFormat,
    duration, totalTime,
    videoUrl, bgImageEnabled, bgImageUrl,
    audioUrl, expAudioBitrate, expAudioSampleRate, expAudioChannels,
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

    // ---- 各层实例 ----
    let decoder = null;
    let renderer = null;
    let encoder = null;
    let hasVideo = !!videoUrl;
    let videoW = w, videoH = h;

    try {
        if (typeof VideoEncoder === 'undefined') throw new Error("浏览器不支持 WebCodecs");

        // ========== 第3层：Renderer 初始化 ==========
        renderer = KiraExport.Renderer({
            width: w, height: h,
            bgImageEnabled, bgImageUrl,
        });
        await renderer.init();

        // ========== 第1层 + 第2层：Container → Decoder ==========
        if (hasVideo) {
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
                    console.log('[Export] <video> 就绪');
                } catch (e) {
                    console.warn('[Export] <video> 失败:', e.message);
                    hasVideo = false;
                    decoder = null;
                }
            }
        }

        // ========== 第4层：Encoder 初始化 ==========
        encoder = KiraExport.Encoder({ width: w, height: h, fps, codec: expCodec, format: expFormat });
        const actualCodec = await encoder.start();

        const t0 = performance.now(); let lastUp = performance.now();
        const codecLabel = actualCodec || expCodec;
        console.log('[Export] ' + w + 'x' + h + ' @' + fps + 'fps  ' + codecLabel + '  ' + totalFrames + 'frames  ' + (hasVideo ? 'video+' : ''));

        // ========== 渲染循环 ==========
        for (let i = 0; i < totalFrames; i++) {
            if (cancelRef && cancelRef.current) { console.log('[Export] 用户取消'); break; }
            const targetTime = i / fps;

            // 获取视频帧
            let videoFrame = null;
            if (decoder) {
                try { videoFrame = await decoder.getFrame(targetTime); } catch (_) { }
            }

            // 渲染
            renderer.renderFrame({
                videoFrame,
                targetTime,
                parsedData,
                config,
                entryBuf,
                videoW,
                videoH,
                hasVideo: !!videoFrame,
            });

            // 编码
            const canvas = renderer.getCanvas();
            encoder.encode(canvas, targetTime, i);

            // 周期性 flush（避免编码器内存堆积）
            if ((i + 1) % (fps * 2) === 0) await encoder.flush();

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
            try { await encoder.finish(); } catch (_) { }
            setExporting(false);
            return;
        }

        // ========== 第4层 finish + 第5层 mux ==========
        setExpEta('封装中...');
        const encChunks = await encoder.finish();
        if (encChunks.length === 0) throw new Error("编码数据为空");

        // 音频管线（仅 mp4 且有音频源时）
        let audioChunks = [];
        if (expFormat === 'mp4' && audioUrl) {
            try {
                setExpEta('编码音频...');
                const sampleRate = expAudioSampleRate || 48000;
                const channels = expAudioChannels || 2;

                const audioEncoder = KiraExport.AudioEncoder({
                    sampleRate, channels,
                    bitrate: (expAudioBitrate || 192) * 1000,
                });
                await audioEncoder.start();

                // 解码完整音频
                const audioResp = await fetch(audioUrl);
                const audioBuf = await audioResp.arrayBuffer();
                const audioCtx = new OfflineAudioContext({ numberOfChannels: channels, length: sampleRate * totalTime, sampleRate });
                const audioBuffer = await audioCtx.decodeAudioData(audioBuf.slice(0));

                const totalFrames = audioBuffer.length;  // 每声道帧数
                const AAC_FRAME_SIZE = 1024;

                // 逐帧编码
                for (let offset = 0; offset < totalFrames; offset += AAC_FRAME_SIZE) {
                    if (cancelRef && cancelRef.current) break;
                    const framesThisChunk = Math.min(AAC_FRAME_SIZE, totalFrames - offset);
                    if (framesThisChunk <= 0) break;

                    const t = offset / sampleRate;
                    const planarBuf = new ArrayBuffer(framesThisChunk * channels * 4); // f32 = 4 bytes
                    const view = new Float32Array(planarBuf);
                    for (let ch = 0; ch < channels; ch++) {
                        const chData = audioBuffer.getChannelData(ch);
                        view.set(chData.slice(offset, offset + framesThisChunk), ch * framesThisChunk);
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
                console.log('[Export] 音频编码完成: ' + audioChunks.length + ' 帧');

                // ---- DIAG: 编码输出诊断 ----
                if (audioChunks.length > 0) {
                    var c0 = audioChunks[0];
                    console.log('[AUDIO-ENC-DIAG] 编码器: ' + audioEncoder.getCodec() + ' sampleRate=' + sampleRate + ' ch=' + channels);
                    console.log('[AUDIO-ENC-DIAG] chunk[0]: ts=' + c0.timestamp + 'us dur=' + c0.duration + ' size=' + c0.data.byteLength +
                        ' hex=' + Array.from(new Uint8Array(c0.data).slice(0, 8)).map(function(b){return b.toString(16).padStart(2,'0')}).join(' '));
                    var sz5 = audioChunks.slice(0, Math.min(5, audioChunks.length)).map(function(c){return c.data.byteLength});
                    console.log('[AUDIO-ENC-DIAG] 前5帧大小: ' + JSON.stringify(sz5));
                    var clast = audioChunks[audioChunks.length - 1];
                    console.log('[AUDIO-ENC-DIAG] chunk[' + (audioChunks.length-1) + ']: ts=' + clast.timestamp + 'us dur=' + clast.duration + ' size=' + clast.data.byteLength +
                        ' hex=' + Array.from(new Uint8Array(clast.data).slice(0, 8)).map(function(b){return b.toString(16).padStart(2,'0')}).join(' '));
                    // 判断是否 ADTS
                    var raw = new Uint8Array(c0.data);
                    var isADTS = raw[0] === 0xFF && (raw[1] & 0xF0) === 0xF0 && raw.length > 7;
                    console.log('[AUDIO-ENC-DIAG] 首帧疑似ADTS: ' + isADTS + ' (0xFFF=' + (raw[0]===0xFF && (raw[1]&0xF0)===0xF0) +
                        ' 首字节=' + raw[0].toString(16) + ' 第2字节=' + raw[1].toString(16) + ')');
                    if (isADTS) {
                        // ADTS header: 7 bytes (or 9 with CRC)
                        var adtsProfile = (raw[2] >> 6) & 0x03;
                        var adtsFreq = (raw[2] >> 2) & 0x0F;
                        var adtsCh = ((raw[2] & 0x01) << 2) | ((raw[3] >> 6) & 0x03);
                        var adtsFrameLen = ((raw[3] & 0x03) << 11) | (raw[4] << 3) | ((raw[5] >> 5) & 0x07);
                        console.log('[AUDIO-ENC-DIAG] ADTS: profile=' + adtsProfile + ' freqIdx=' + adtsFreq + ' ch=' + adtsCh + ' frameLen=' + adtsFrameLen + ' (实际=' + raw.length + ')');
                    }
                }
            } catch (e) {
                console.warn('[Export] 音频编码失败，导出无音频视频:', e.message);
            }
        }

        const muxer = KiraExport.createMuxer(expFormat || 'webm');
        const muxOpts = {
            width: w, height: h,
            codec: actualCodec,
            durationMs: totalTime * 1000,
            fps,
            avcDesc: encoder.getDescription(),  // metadata.decoderConfig.description
        };
        if (audioChunks.length > 0) {
            muxOpts.audioChunks = audioChunks;
            muxOpts.audioSampleRate = expAudioSampleRate || 48000;
            muxOpts.audioChannels = expAudioChannels || 2;
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
