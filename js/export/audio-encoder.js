// ==================== 第4层扩展：AudioEncoder（音频编码） ====================
// 职责：输入 AudioData，输出 AAC 编码块
// 依赖: ../codec.js (configureAudioEncoder)

var KiraExport = window.KiraExport || {};

KiraExport.AudioEncoder = function (opts) {
    opts = opts || {};
    const sampleRate = opts.sampleRate || 48000;
    const channels = opts.channels || 2;
    const bitrate = opts.bitrate || 192000;

    let encoder = null;
    let encChunks = [];
    let encError = null;
    let actualCodec = null;
    let started = false;

    const start = async () => {
        if (typeof AudioEncoder === 'undefined') throw new Error("浏览器不支持 WebCodecs AudioEncoder");

        encChunks = [];
        encError = null;

        encoder = new AudioEncoder({
            output: chunk => {
                const buf = new Uint8Array(chunk.byteLength);
                chunk.copyTo(buf);
                encChunks.push({
                    data: buf,
                    timestamp: chunk.timestamp,
                    duration: chunk.duration,
                    isKey: true, // AAC 全部视为 key
                });
            },
            error: e => { encError = e; console.error('[AudioEncoder]', e); },
        });

        actualCodec = await configureAudioEncoder(encoder, sampleRate, channels, bitrate);
        started = true;

        console.log('[AudioEncoder] AAC 编码器就绪 ' + sampleRate + 'Hz ' + channels + 'ch ' + bitrate + 'bps');
        return actualCodec;
    };

    /**
     * 编码一帧音频
     * @param {AudioData} audioData - WebCodecs AudioData
     */
    const encode = (audioData) => {
        if (!started || encError) throw encError || new Error('音频编码器未启动');
        encoder.encode(audioData);
    };

    /**
     * 完成编码
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

    const getCodec = () => actualCodec;

    return { start, encode, finish, getCodec };
};
