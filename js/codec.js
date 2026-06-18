// ==================== 编码器工具 ====================

function getVP9CodecString(width, height, fps) {
    const pixelsPerSec = width * height * fps;
    let level;
    // if (pixelsPerSec <= 854 * 480 * 30) level = '10';
    // else if (pixelsPerSec <= 854 * 480 * 60) level = '11';
    // else if (pixelsPerSec <= 1280 * 720 * 30) level = '20';
    // else if (pixelsPerSec <= 1280 * 720 * 60) level = '21';
    // else if (pixelsPerSec <= 1920 * 1080 * 30) level = '31';
    // else if (pixelsPerSec <= 1920 * 1080 * 60) level = '41';
    // else if (pixelsPerSec <= 3840 * 2160 * 30) level = '50';
    // else if (pixelsPerSec <= 3840 * 2160 * 60) level = '51';
    // else if (pixelsPerSec <= 3840 * 2160 * 120) level = '52';
    // else if (pixelsPerSec <= 7680 * 4320 * 30) level = '60';
    // else if (pixelsPerSec <= 7680 * 4320 * 60) level = '61';
    // else level = '62';
    level = '62';
    return `vp09.00.${level}.08`;
}

function getAVCCodecString(profile, level) {
    return profile || 'avc1.640034';
}

async function configureVideoEncoder(encoder, preferredCodec, w, h, fps, opts = {}) {
    const { format, bitrate } = opts;  // format: 'webm'|'mp4'

    // mp4 只能用 H.264；webm 用 VP9/VP8
    const candidates = (format === 'mp4')
        ? [preferredCodec, 'avc1.640034', 'avc1.42001f', 'avc1.4d0028',]  // mp4: 只试 AVC (baseline→main→high)
        : [preferredCodec].concat(preferredCodec !== 'vp8' ? ['vp8'] : []);

    // 去重
    const unique = [...new Set(candidates)];

    let lastError = null;
    for (const codec of unique) {
        // mp4 下跳过非 AVC codec
        if (format === 'mp4' && !codec.startsWith('avc1')) {
            console.warn('[Codec] mp4 格式跳过非 AVC codec: ' + codec);
            continue;
        }

        const checkCfg = {
            codec, 
            width: w, 
            height: h, 
            bitrate: bitrate || 15_000_000, 
            framerate: fps
        };
        const check = await VideoEncoder.isConfigSupported(checkCfg);
        if (!check.supported) {
            continue;
        }

        // AVC 只软解
        const hwList = (codec.startsWith('avc1'))
            ? ['prefer-software']
            : ['prefer-software', 'prefer-hardware'];

        for (const hw of hwList) {
            try {
                const cfg = {
                    codec,
                    width: w,
                    height: h,
                    bitrate: bitrate || 35_000_000,
                    framerate: fps,
                    bitrateMode: 'variable',
                    latencyMode: 'quality',
                };
                if (codec.startsWith('avc1')) cfg.hardwareAcceleration = hw;
                encoder.configure(cfg);
                return codec;
            } catch (e) {
                lastError = e;
                console.log('[Codec] ' + codec + ' configure() 失败: ' + (e.message || e));
            }
        }
    }
    throw new Error(`无法创建编码器 (${format || 'webm'}): ${lastError?.message || '所有候选 codec 均失败'}`);
}

function codecToMuxLabel(codec) {
    if (!codec) return 'vp9';
    if (codec === 'vp8') return 'vp8';
    if (codec.startsWith('avc1')) return 'avc1';
    return 'vp9';
}

// ---- 音频编码器 ----

function getAACCodecString(sampleRate, channels) {
    // AAC-LC: mp4a.40.2
    return 'mp4a.40.2';
}

async function configureAudioEncoder(encoder, sampleRate, channels, bitrate) {
    const codec = getAACCodecString(sampleRate, channels);
    const check = await AudioEncoder.isConfigSupported({
        codec,
        sampleRate: sampleRate || 48000,
        numberOfChannels: channels || 2,
        bitrate: bitrate || 192000,
    });
    if (!check.supported) {
        // 回退到更低参数
        const fallback = await AudioEncoder.isConfigSupported({
            codec, sampleRate: 44100, numberOfChannels: 1, bitrate: 128000,
        });
        if (fallback.supported) {
            encoder.configure({ codec, sampleRate: 44100, numberOfChannels: 1, bitrate: 128000 });
            return codec;
        }
        throw new Error('AAC 编码不支持: ' + codec);
    }
    encoder.configure({ codec, sampleRate: sampleRate || 48000, numberOfChannels: channels || 2, bitrate: bitrate || 192000 });
    return codec;
}

async function configureOpusAudioEncoder(encoder, sampleRate, channels, bitrate) {
    const codec = 'opus';
    const check = await AudioEncoder.isConfigSupported({
        codec,
        sampleRate: sampleRate || 48000,
        numberOfChannels: channels || 2,
        bitrate: bitrate || 128000,
    });
    if (!check.supported) {
        throw new Error('Opus 编码不支持');
    }
    encoder.configure({
        codec,
        sampleRate: sampleRate || 48000,
        numberOfChannels: channels || 2,
        bitrate: bitrate || 128000,
    });
    return codec;
}
