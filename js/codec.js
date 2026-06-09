// ==================== 编码器工具 ====================

function getVP9CodecString(width, height, fps) {
    const pixelsPerSec = width * height * fps;
    let level;
    if      (pixelsPerSec <=   854 *  480 * 30)  level = '10';
    else if (pixelsPerSec <=   854 *  480 * 60)  level = '11';
    else if (pixelsPerSec <=  1280 *  720 * 30)  level = '20';
    else if (pixelsPerSec <=  1280 *  720 * 60)  level = '21';
    else if (pixelsPerSec <=  1920 * 1080 * 30)  level = '31';
    else if (pixelsPerSec <=  1920 * 1080 * 60)  level = '41';
    else if (pixelsPerSec <=  3840 * 2160 * 30)  level = '50';
    else if (pixelsPerSec <=  3840 * 2160 * 60)  level = '51';
    else if (pixelsPerSec <=  3840 * 2160 * 120) level = '52';
    else if (pixelsPerSec <=  7680 * 4320 * 30)  level = '60';
    else if (pixelsPerSec <=  7680 * 4320 * 60)  level = '61';
    else                                          level = '62';
    return `vp09.00.${level}.08`;
}

async function configureVideoEncoder(encoder, preferredCodec, w, h, fps, log) {
    const candidates = [preferredCodec];
    if (preferredCodec !== 'vp8') candidates.push('vp8');

    let lastError = null;
    for (const codec of candidates) {
        const check = await VideoEncoder.isConfigSupported({
            codec, width: w, height: h,
            bitrate: 15_000_000, framerate: fps,
        });
        if (!check.supported) {
            log(`  ⚠ ${codec} isConfigSupported=false，跳过`);
            continue;
        }
        for (const hw of ['prefer-software', 'prefer-hardware']) {
            try {
                encoder.configure({
                    codec, width: w, height: h,
                    bitrate: 15_000_000, framerate: fps,
                    latencyMode: 'realtime',
                    hardwareAcceleration: hw,
                });
                log(`  ✓ 编码器就绪: ${codec} (${hw})`);
                return codec;
            } catch (e) {
                lastError = e;
            }
        }
        log(`  ✗ ${codec} configure() 失败: ${lastError?.message}`);
    }
    throw new Error(`无法创建编码器: ${lastError?.message || '所有候选 codec 均失败'}`);
}

function codecToMuxLabel(codec) {
    if (codec === 'vp8') return 'vp8';
    return 'vp9';
}
