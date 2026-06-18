// ==================== 第4层扩展：AudioEncoder（音频编码） ====================
// 职责：输入 AudioData，输出 AAC(mp4) 或 Opus(webm) 编码块
// 依赖: ../codec.js (configureAudioEncoder, configureOpusAudioEncoder)

var KiraExport = window.KiraExport || {};

KiraExport.AudioEncoder = function (opts) {
    opts = opts || {};
    const sampleRate = opts.sampleRate || 48000;
    const channels = opts.channels || 2;
    const bitrate = opts.bitrate || 192000;
    const format = opts.format || 'webm'; // 'mp4'→AAC, 'webm'→Opus

    let encoder = null;
    let encChunks = [];
    let encError = null;
    let actualCodec = null;
    let started = false;
    let _description = null; // OpusHead / AAC ASC

    const start = async () => {
        if (typeof AudioEncoder === 'undefined') throw new Error("浏览器不支持 WebCodecs AudioEncoder");

        encChunks = [];
        encError = null;
        _description = null;

        encoder = new AudioEncoder({
            output: (chunk, metadata) => {
                const buf = new Uint8Array(chunk.byteLength);
                chunk.copyTo(buf);
                encChunks.push({
                    data: buf,
                    timestamp: chunk.timestamp,
                    duration: chunk.duration,
                    isKey: true,
                });

                // 从 metadata 捕获 codec description（OpusHead / ASC）
                if (!_description && metadata && metadata.decoderConfig && metadata.decoderConfig.description) {
                    const desc = metadata.decoderConfig.description;
                    _description = desc instanceof Uint8Array ? desc : new Uint8Array(desc);
                }
            },
            error: e => { encError = e; console.error('[AudioEncoder]', e); },
        });

        if (format === 'mp4') {
            actualCodec = await configureAudioEncoder(encoder, sampleRate, channels, bitrate);
        } else {
            actualCodec = await configureOpusAudioEncoder(encoder, sampleRate, channels, bitrate);
        }
        started = true;

        const label = format === 'mp4' ? 'AAC' : 'Opus';
        console.log('[AudioEncoder] ' + label + ' 编码器就绪 ' + sampleRate + 'Hz ' + channels + 'ch ' + bitrate + 'bps');
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

    /** 获取 codec description（OpusHead / AAC ASC），从 metadata.decoderConfig.description 捕获 */
    const getDescription = () => _description;

    return { start, encode, finish, getCodec, getDescription };
};
