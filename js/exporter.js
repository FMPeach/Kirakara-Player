// ==================== Canvas 2D 导出流水线 ====================
// 依赖: export/container-reader.js, export/decoder-provider.js, export/renderer.js,
//        export/encoder.js, export/muxer.js, canvas-renderer.js, codec.js, muxer.js

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
        encoder = KiraExport.Encoder({ width: w, height: h, fps, codec: expCodec });
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

        const muxer = KiraExport.createMuxer('webm');
        const webmBlob = muxer.mux(encChunks, {
            width: w, height: h,
            codec: actualCodec,
            durationMs: totalTime * 1000,
        });
        download(webmBlob, `krkr-export-${w}x${h}-${Date.now()}.webm`);
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
