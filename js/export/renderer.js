// ==================== 第3层：Renderer（帧渲染） ====================
// 职责：将视频帧 + 背景 + 歌词绘制到 canvas 上
// 禁止编码！
// 依赖: ../canvas-renderer.js (drawLyricsOnCanvas)

var KiraExport = window.KiraExport || {};

KiraExport.Renderer = function (opts) {
    opts = opts || {};
    const w = opts.width || 1920;
    const h = opts.height || 1080;
    const bgImageEnabled = opts.bgImageEnabled || false;
    const bgImageUrl = opts.bgImageUrl || null;
    const titleBackgroundUrl = opts.titleBackgroundUrl || null;
    const transparent = opts.transparent || false;  // PNG 序列导出：不画背景，字幕保留透明底

    // ---- 内部状态 ----
    let offCanvas = null;
    let octx = null;
    let bgImgObj = null;
    let bgReady = false;
    let bgBlurCache = null;  // 预渲染：模糊背景（blur+brightness）
    let bgFgCache = null;    // 预渲染：居中前景图（无透明度）
    let titleBgImgObj = null;
    let titleBgReady = false;

    // ---- 初始化 ----
    const init = async () => {
        offCanvas = document.createElement('canvas');
        offCanvas.width = w;
        offCanvas.height = h;
        octx = offCanvas.getContext('2d', { willReadFrequently: true });

        if (bgImageEnabled && bgImageUrl) {
            bgImgObj = new Image();
            bgImgObj.src = bgImageUrl;
            await new Promise(r => { bgImgObj.onload = r; bgImgObj.onerror = r; });
            bgReady = !!(bgImgObj.complete && bgImgObj.naturalWidth > 0);

            if (bgReady) {
                // 预渲染模糊背景（只做一次，避免每帧 blur(20px) 的 GPU/CPU 开销）
                bgBlurCache = document.createElement('canvas');
                bgBlurCache.width = w;
                bgBlurCache.height = h;
                const bctx = bgBlurCache.getContext('2d');
                bctx.filter = 'blur(20px) brightness(0.4)';
                const bs = Math.max(w / bgImgObj.naturalWidth, h / bgImgObj.naturalHeight);
                const bdw = bgImgObj.naturalWidth * bs;
                const bdh = bgImgObj.naturalHeight * bs;
                bctx.drawImage(bgImgObj, (w - bdw) / 2, (h - bdh) / 2, bdw, bdh);

                // 预渲染居中前景图（不透明度在每帧通过 globalAlpha 叠加）
                bgFgCache = document.createElement('canvas');
                bgFgCache.width = w;
                bgFgCache.height = h;
                const fctx = bgFgCache.getContext('2d');
                const sbg = Math.min(w / bgImgObj.naturalWidth, h / bgImgObj.naturalHeight);
                const dw = bgImgObj.naturalWidth * sbg;
                const dh = bgImgObj.naturalHeight * sbg;
                fctx.drawImage(bgImgObj, (w - dw) / 2, (h - dh) / 2, dw, dh);
            }
        }

        if (titleBackgroundUrl) {
            titleBgImgObj = new Image();
            titleBgImgObj.src = titleBackgroundUrl;
            await new Promise(r => { titleBgImgObj.onload = r; titleBgImgObj.onerror = r; });
            titleBgReady = !!(titleBgImgObj.complete && titleBgImgObj.naturalWidth > 0);
        }
    };

    // ---- 渲染单帧 ----
    /**
     * @param {object} params
     * @param {VideoFrame|HTMLVideoElement|null} params.videoFrame - 视频帧（VideoFrame 或 <video>）
     * @param {number} params.targetTime - 当前时间（秒）
     * @param {Array} params.parsedData - 歌词解析数据
     * @param {object} params.config - 样式配置
     * @param {number} params.entryBuf - 入场缓冲
     * @param {number} [params.videoW] - 视频原始宽度
     * @param {number} [params.videoH] - 视频原始高度
     * @param {boolean} [params.hasVideo] - 是否有视频
     * @returns {HTMLCanvasElement} 渲染好的 canvas
     */
    const renderFrame = (params) => {
        const {
            videoFrame,
            targetTime,
            projectTime = targetTime,
            parsedData,
            config,
            entryBuf,
            videoW = w,
            videoH = h,
            hasVideo = !!videoFrame,
        } = params;

        octx.clearRect(0, 0, w, h);

        if (!transparent) {
        // === 背景填充 ===
        const isVideoFrame = videoFrame && !(videoFrame instanceof HTMLVideoElement);
        const isVideoEl = videoFrame && (videoFrame instanceof HTMLVideoElement) && videoFrame.readyState >= 2;

        if (isVideoFrame || isVideoEl) {
            // 有视频帧时，黑底衬底
            octx.fillStyle = '#000';
            octx.fillRect(0, 0, w, h);
        } else if (bgBlurCache && bgFgCache) {
            // 从预渲染缓存绘制（blur 只做一次，每帧仅 drawImage）
            octx.drawImage(bgBlurCache, 0, 0);
            octx.save();
            octx.globalAlpha = config.bgImageOpacity ?? 1;
            octx.drawImage(bgFgCache, 0, 0);
            octx.restore();
        } else {
            octx.fillStyle = config.bgColor || '#000';
            octx.fillRect(0, 0, w, h);
        }

        // === 视频帧：letterbox 保持宽高比 ===
        if (isVideoFrame) {
            const scale = Math.min(w / videoW, h / videoH);
            const dw = videoW * scale, dh = videoH * scale;
            octx.drawImage(videoFrame, (w - dw) / 2, (h - dh) / 2, dw, dh);
        } else if (isVideoEl) {
            const evw = videoFrame.videoWidth || videoW;
            const evh = videoFrame.videoHeight || videoH;
            const scale = Math.min(w / evw, h / evh);
            const dw = evw * scale, dh = evh * scale;
            octx.drawImage(videoFrame, (w - dw) / 2, (h - dh) / 2, dw, dh);
        }

        // === 标题前补背景 ===
        const preludeState = getPreludeBackgroundState(projectTime, config.songTitle);
        if (preludeState.visible) {
            octx.save();
            octx.globalAlpha = preludeState.layerAlpha;
            octx.fillStyle = '#000000';
            octx.fillRect(0, 0, w, h);
            if (titleBgReady) {
                const scale = Math.max(w / titleBgImgObj.naturalWidth, h / titleBgImgObj.naturalHeight);
                const dw = titleBgImgObj.naturalWidth * scale;
                const dh = titleBgImgObj.naturalHeight * scale;
                octx.globalAlpha = preludeState.layerAlpha * preludeState.imageAlpha;
                octx.drawImage(titleBgImgObj, (w - dw) / 2, (h - dh) / 2, dw, dh);
            }
            octx.restore();
        }
        }

        // === 标题与歌词 ===
        octx.save();
        octx.scale(w / 1280, h / 720);
        drawSongTitleOnCanvas(octx, projectTime, config);
        const prependDuration = getSongTitlePrependDuration(config.songTitle);
        if (prependDuration <= 0 || projectTime >= 0) {
            drawLyricsOnCanvas(octx, parsedData, projectTime, config, entryBuf);
        }
        octx.restore();

        return offCanvas;
    };

    /**
     * 获取离屏 canvas（供 encoder 创建 VideoFrame）
     */
    const getCanvas = () => offCanvas;

    return { init, renderFrame, getCanvas };
};
