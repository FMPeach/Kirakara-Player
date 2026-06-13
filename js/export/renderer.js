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

    // ---- 内部状态 ----
    let offCanvas = null;
    let octx = null;
    let bgImgObj = null;
    let bgReady = false;

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
            parsedData,
            config,
            entryBuf,
            videoW = w,
            videoH = h,
            hasVideo = !!videoFrame,
        } = params;

        octx.clearRect(0, 0, w, h);

        // === 背景填充 ===
        const isVideoFrame = videoFrame && !(videoFrame instanceof HTMLVideoElement);
        const isVideoEl = videoFrame && (videoFrame instanceof HTMLVideoElement) && videoFrame.readyState >= 2;

        if (isVideoFrame || isVideoEl) {
            // 有视频帧时，黑底衬底
            octx.fillStyle = '#000';
            octx.fillRect(0, 0, w, h);
        } else if (bgImgObj && bgReady) {
            // 模糊背景 + 居中背景图
            octx.save(); octx.filter = 'blur(20px) brightness(0.4)'; octx.drawImage(bgImgObj, 0, 0, w, h); octx.restore();
            octx.save(); octx.globalAlpha = config.bgImageOpacity ?? 1;
            const sbg = Math.min(w / bgImgObj.naturalWidth, h / bgImgObj.naturalHeight);
            octx.drawImage(bgImgObj, (w - bgImgObj.naturalWidth * sbg) / 2, (h - bgImgObj.naturalHeight * sbg) / 2, bgImgObj.naturalWidth * sbg, bgImgObj.naturalHeight * sbg);
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

        // === 歌词 ===
        octx.save();
        octx.scale(w / 1280, h / 720);
        drawLyricsOnCanvas(octx, parsedData, targetTime, config, entryBuf);
        octx.restore();

        return offCanvas;
    };

    /**
     * 获取离屏 canvas（供 encoder 创建 VideoFrame）
     */
    const getCanvas = () => offCanvas;

    return { init, renderFrame, getCanvas };
};
