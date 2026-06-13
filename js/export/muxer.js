// ==================== 第5层：Muxer（封装） ====================
// 依赖: ../muxer.js (muxWebM)

var KiraExport = window.KiraExport || {};

// --- WebM Muxer ---
// 直接委托现有 muxWebM
KiraExport.WebMMuxer = {
    mux(chunks, opts) {
        return muxWebM(chunks, {
            width: opts.width,
            height: opts.height,
            codec: codecToMuxLabel(opts.codec),
            durationMs: opts.durationMs,
        });
    }
};

// --- Mp4 Muxer ---
// TODO: 未来支持 mp4 输出时实现
KiraExport.Mp4Muxer = {
    mux(chunks, opts) {
        throw new Error('Mp4Muxer 尚未实现');
    }
};

// --- 便捷工厂 ---
KiraExport.createMuxer = function (format) {
    if (format === 'mp4') return KiraExport.Mp4Muxer;
    return KiraExport.WebMMuxer;  // 默认 webm
};
