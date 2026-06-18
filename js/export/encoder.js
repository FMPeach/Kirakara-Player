// ==================== 第4层：Encoder（编码） ====================
// 职责：接收 canvas，输出编码块
// 依赖: ../codec.js (configureVideoEncoder, getVP9CodecString)

var KiraExport = window.KiraExport || {};

KiraExport.Encoder = function (opts) {
    opts = opts || {};
    const w = opts.width || 1920;
    const h = opts.height || 1080;
    const fps = opts.fps || 60;
    const expCodec = opts.codec || 'vp9';     // 'vp9' | 'vp8' | 'h264'
    const format = opts.format || 'webm';      // 'webm' | 'mp4'
    const bitrate = opts.bitrate || undefined; // undefined → 默认 15Mbps

    let encoder = null;
    let encChunks = [];
    let encError = null;
    let actualCodec = null;
    let started = false;
    let _description = null;  // avcC from metadata.decoderConfig.description

    const dumpNAL = function(buf) {
        let i = 0;
        const arr = [];
        while (i + 4 < buf.length) {
            const len = (buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3];
            if (len <= 0 || i + 4 + len > buf.length) break;
            const type = buf[i + 4] & 0x1F;
            arr.push(type);
            i += 4 + len;
        }
        return arr;
    };

    const start = async () => {
        if (typeof VideoEncoder === 'undefined') throw new Error("浏览器不支持 WebCodecs");

        const codecStr = expCodec === 'vp8' ? 'vp8'
            : expCodec === 'h264' ? 'avc1.640034'
            : getVP9CodecString(w, h, fps);

        encChunks = [];
        encError = null;
        _description = null;

        encoder = new VideoEncoder({
            output: (chunk, metadata) => {
                const buf = new Uint8Array(chunk.byteLength);
                chunk.copyTo(buf);
                encChunks.push({ data: buf, timestamp: chunk.timestamp, isKey: chunk.type === 'key' });

                // 从 metadata 提取 avcC
                if (!_description && metadata && metadata.decoderConfig && metadata.decoderConfig.description) {
                    const desc = metadata.decoderConfig.description;
                    _description = desc instanceof Uint8Array ? desc : new Uint8Array(desc);
                }
            },
            error: e => { encError = e; console.error('[Encoder]', e); },
        });

        actualCodec = await configureVideoEncoder(encoder, codecStr, w, h, fps, { format, bitrate });
        started = true;

        return actualCodec;
    };

    /**
     * 编码一帧
     * @param {HTMLCanvasElement} canvas - 渲染好的 canvas
     * @param {number} timeSec - 帧时间戳（秒）
     * @param {number} frameIndex - 帧序号（用于关键帧判断）
     */
    const encode = (canvas, timeSec, frameIndex) => {
        if (!started || encError) throw encError || new Error('编码器未启动');
        const vf = new VideoFrame(canvas, {
            timestamp: Math.round(timeSec * 1_000_000),
            duration: Math.round(1_000_000 / fps),
        });
        encoder.encode(vf, { keyFrame: (frameIndex % fps === 0) });
        vf.close();
    };

    /**
     * 周期性 flush（释放编码器内部缓冲）
     */
    const flush = async () => {
        if (encoder && started) {
            await encoder.flush();
        }
    };

    /**
     * 完成编码，返回编码块
     * @returns {Promise<Array<{data:Uint8Array, timestamp:number, isKey:boolean}>>}
     */
    const finish = async () => {
        if (!encoder) return [];

        if (encError) throw encError;

        await encoder.flush();
        encoder.close();

        const chunks = encChunks.slice();
        encChunks = [];
        started = false;
        return chunks;
    };

    /**
     * 获取实际使用的 codec 字符串（用于 mux label）
     */
    const getCodec = () => actualCodec;

    /**
     * 获取 codec description（avcC），从 metadata.decoderConfig.description 捕获
     * 仅在编码完成后有效
     */
    const getDescription = () => _description;

    return { start, encode, flush, finish, getCodec, getDescription };
};
