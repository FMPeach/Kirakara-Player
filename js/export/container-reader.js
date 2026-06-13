// ==================== 第1层：ContainerReader（容器读取） ====================
// 职责：打开视频文件，提取编码信息 + 样本数据 + codec description
// 依赖: mp4box (CDN)

var KiraExport = window.KiraExport || {};

// ============ 内部辅助 ============

// Uint8Array 归一化
function _toU8(src) {
    if (!src && src !== 0) return null;
    if (src instanceof Uint8Array) return src;
    if (src instanceof ArrayBuffer) return new Uint8Array(src);
    if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset || 0, src.byteLength || src.length);
    if (typeof src.length === 'number') { const arr = new Uint8Array(src.length); for (let i = 0; i < src.length; i++) arr[i] = (typeof src[i] === 'number' ? src[i] : 0) & 0xff; return arr; }
    return null;
}

// NAL 单元提取（用于 avcC SPS/PPS）
function _getNAL(field) {
    if (!field) return [];
    if (Array.isArray(field)) return field.map(n => {
        if (n instanceof Uint8Array || ArrayBuffer.isView(n)) return _toU8(n);
        if (n && n.nalu) return _toU8(n.nalu); if (n && n.data) return _toU8(n.data);
        if (typeof n.length === 'number') return _toU8(n);
        return null;
    }).filter(Boolean);
    const s = _toU8(field); if (s && s.length >= 4) return [s];
    if (typeof field.length === 'number' && field.length > 0) { const a = _toU8(field); if (a && a.length >= 4) return [a]; }
    return [];
}

// ============ Mp4Reader ============

KiraExport.Mp4Reader = {
    /**
     * 打开 mp4 文件，返回统一 Track 对象
     * @param {string} url - 视频 URL
     * @param {object} [opts]
     * @param {function} [opts.onProgress] - 进度回调 (msg)
     * @returns {Promise<{ codec, width, height, duration, samples, codecDescription }>}
     */
    async open(url, opts = {}) {
        const { onProgress } = opts;
        if (typeof MP4Box === 'undefined') throw new Error('MP4Box 不可用');

        if (onProgress) onProgress('解析视频流...');
        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        const file = MP4Box.createFile();
        const samples = [];
        let trackInfo = null;

        await new Promise((resolve, reject) => {
            file.onReady = (info) => {
                trackInfo = info.videoTracks[0];
                if (!trackInfo) { reject(new Error('无视频轨道')); return; }
                file.setExtractionOptions(trackInfo.id);
                file.onSamples = (_id, _user, s) => {
                    for (const sample of s) {
                        samples.push({
                            timeSec: sample.cts / sample.timescale,
                            dtsSec: (sample.dts !== undefined ? sample.dts : sample.cts) / sample.timescale,
                            isKey: sample.is_sync,
                            data: new Uint8Array(sample.data),
                            durationSec: sample.duration / sample.timescale,
                        });
                    }
                };
                file.start();
            };
            file.onError = (e) => { reject(e); };
            buf.fileStart = 0;
            file.appendBuffer(buf);
            file.flush();
            setTimeout(() => {
                if (samples.length > 0) resolve();
                else reject(new Error('mp4box 未提取到任何样本'));
            }, 1000);
        });

        const rawCodec = trackInfo.codec || '';
        const isAVC = rawCodec.startsWith('avc1') || rawCodec.startsWith('avc3');
        const isHEVC = rawCodec.startsWith('hvc1') || rawCodec.startsWith('hev1');
        const isVP8 = rawCodec.startsWith('vp08');
        const isVP9 = rawCodec.startsWith('vp09');
        const isAV1 = rawCodec.startsWith('av01');

        // === codec description 提取（avcC / hvcC / vpcC / av1C） ===
        let codecDesc = null;
        try {
            const internalTrack = file.getTrackById(trackInfo.id);
            const stsd = internalTrack?.mdia?.minf?.stbl?.stsd;
            const entry = stsd?.entries?.[0];

            if (entry?.avcC && isAVC) {
                // --- avcC → AVCDecoderConfigurationRecord ---
                const box = entry.avcC;
                if (box.configurationVersion !== undefined) {
                    const sl = _getNAL(box.SPS), pl = _getNAL(box.PPS);
                    if (sl.length > 0 && pl.length > 0) {
                        let total = 7;
                        for (const s of sl) total += 2 + s.length;
                        total += 1;
                        for (const p of pl) total += 2 + p.length;
                        codecDesc = new Uint8Array(total);
                        let off = 0;
                        codecDesc[off++] = box.configurationVersion || 1;
                        codecDesc[off++] = box.AVCProfileIndication || 66;
                        codecDesc[off++] = box.profile_compatibility || 0;
                        codecDesc[off++] = box.AVCLevelIndication || 40;
                        codecDesc[off++] = ((box.lengthSizeMinusOne || 3) & 0x03) | 0xFC;
                        codecDesc[off++] = (sl.length & 0x1F) | 0xE0;
                        for (const s of sl) { codecDesc[off++] = (s.length >> 8) & 0xFF; codecDesc[off++] = s.length & 0xFF; codecDesc.set(s, off); off += s.length; }
                        codecDesc[off++] = pl.length & 0xFF;
                        for (const p of pl) { codecDesc[off++] = (p.length >> 8) & 0xFF; codecDesc[off++] = p.length & 0xFF; codecDesc.set(p, off); off += p.length; }
                    }
                }
            } else if (entry?.hvcC && isHEVC) {
                // --- hvcC：从 mp4box 箱内 data 直取 ---
                const box = entry.hvcC;
                if (box.data) {
                    codecDesc = new Uint8Array(box.data).slice().buffer;
                    console.log('[ContainerReader] HEVC description: ' + codecDesc.byteLength + 'B');
                } else {
                    console.warn('[ContainerReader] HEVC description 不可用');
                }
            } else if (entry?.vpcC && isVP9) {
                // --- vpcC：VP9 在 mp4 中的 codec description ---
                const box = entry.vpcC;
                if (box.data) {
                    codecDesc = new Uint8Array(box.data).slice().buffer;
                    console.log('[ContainerReader] VP9 (mp4) vpcC: ' + codecDesc.byteLength + 'B');
                }
            } else if (entry?.av1C && isAV1) {
                // --- av1C：AV1 在 mp4 中的 codec description ---
                const box = entry.av1C;
                if (box.data) {
                    codecDesc = new Uint8Array(box.data).slice().buffer;
                    console.log('[ContainerReader] AV1 (mp4) av1C: ' + codecDesc.byteLength + 'B');
                }
            }
        } catch (e) {
            console.warn('[ContainerReader] codec description 提取失败:', e.message);
        }

        if (isAVC && !codecDesc) throw new Error(rawCodec + ' 缺少 codec description');

        return {
            codec: trackInfo.codec || rawCodec,
            width: trackInfo.track_width || trackInfo.video.width,
            height: trackInfo.track_height || trackInfo.video.height,
            duration: samples.length > 0 ? samples[samples.length - 1].timeSec + samples[samples.length - 1].durationSec : 0,
            samples,
            codecDescription: codecDesc,
            _rawCodec: rawCodec,
            _isAVC: isAVC,
            _isHEVC: isHEVC,
            _isVP8: isVP8,
            _isVP9: isVP9,
            _isAV1: isAV1,
        };
    }
};

// ============ WebMReader（EBML 解析，提取编码样本） ============

KiraExport.WebMReader = {
    async open(url, opts = {}) {
        const { onProgress } = opts;
        if (onProgress) onProgress('解析 WebM 容器...');

        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        const data = new Uint8Array(buf);

        // ---- EBML VINT 解析 ----
        const readVint = (offset) => {
            if (offset >= data.length) return null;
            const first = data[offset];
            if (first === 0) return { value: 0, length: 1, end: offset + 1 };  // 0x00 特殊
            let len = 1, mask = 0x80;
            while (len < 8 && !(first & mask)) { len++; mask >>= 1; }
            if (len > 8 || offset + len > data.length) return null;
            let val = first & (mask - 1);
            for (let i = 1; i < len; i++) val = (val << 8) | data[offset + i];
            return { value: val, length: len, end: offset + len };
        };

        const readElement = (offset) => {
            const id = readVint(offset);
            if (!id) return null;
            const size = readVint(id.end);
            if (!size) return null;
            return { id: id.value, size: size.value, dataOffset: size.end, end: size.end + size.value, idLen: id.length, sizeLen: size.length };
        };

        const readString = (offset, size) => {
            let s = '';
            for (let i = 0; i < size; i++) s += String.fromCharCode(data[offset + i]);
            return s;
        };

        // ---- 解析 Track 信息（Tracks 区内） ----
        let videoTrack = null;
        let timecodeScale = 1000000; // 默认：1ms = 1,000,000 纳秒

        const parseTracks = (offset, end) => {
            let pos = offset;
            while (pos < end) {
                const el = readElement(pos);
                if (!el || el.end > end) break;
                if (el.id === 0xAE) { // TrackEntry
                    parseTrackEntry(el.dataOffset, el.end);
                }
                pos = el.end;
            }
        };

        const parseTrackEntry = (offset, end) => {
            let trackNum = 0, trackType = 0, codecId = '', codecPrivate = null;
            let pixelW = 0, pixelH = 0;

            let pos = offset;
            while (pos < end) {
                const el = readElement(pos);
                if (!el || el.end > end) break;
                switch (el.id) {
                    case 0xD7: trackNum = readVint(el.dataOffset)?.value || 0; break;
                    case 0x83: trackType = data[el.dataOffset] || 0; break;
                    case 0x86: codecId = readString(el.dataOffset, el.size); break;
                    case 0x63A2: codecPrivate = data.slice(el.dataOffset, el.dataOffset + el.size); break;
                    case 0xE0: // Video
                        parseVideo(el.dataOffset, el.end);
                        break;
                }
                pos = el.end;
            }

            if (trackType === 1 && codecId) {
                videoTrack = { trackNum, codecId, codecPrivate: codecPrivate ? new Uint8Array(codecPrivate) : null, width: pixelW, height: pixelH };
            }

            function parseVideo(vo, ve) {
                let vp = vo;
                while (vp < ve) {
                    const el = readElement(vp);
                    if (!el || el.end > ve) break;
                    if (el.id === 0xB0) pixelW = readVint(el.dataOffset)?.value || data[el.dataOffset + el.size - 1] || 0;
                    if (el.id === 0xBA) pixelH = readVint(el.dataOffset)?.value || data[el.dataOffset + el.size - 1] || 0;
                    // For width/height that might be stored as uint (not VINT), try direct read
                    if (pixelW === 0 && el.id === 0xB0 && el.size <= 4) {
                        let v = 0; for (let i = 0; i < el.size; i++) v = (v << 8) | data[el.dataOffset + i]; pixelW = v;
                    }
                    if (pixelH === 0 && el.id === 0xBA && el.size <= 4) {
                        let v = 0; for (let i = 0; i < el.size; i++) v = (v << 8) | data[el.dataOffset + i]; pixelH = v;
                    }
                    vp = el.end;
                }
            }
        };

        const parseInfo = (offset, end) => {
            let pos = offset;
            while (pos < end) {
                const el = readElement(pos);
                if (!el || el.end > end) break;
                if (el.id === 0x2AD7B1) { // TimecodeScale
                    let v = 0; for (let i = 0; i < el.size; i++) v = (v << 8) | data[el.dataOffset + i];
                    timecodeScale = v || 1000000;
                }
                if (el.id === 0x4489) { // Duration (float64)
                    const dv = new DataView(data.buffer, data.byteOffset + el.dataOffset, 8);
                    videoTrack._duration = dv.getFloat64(0) * timecodeScale / 1e9; // 纳秒 → 秒
                }
                pos = el.end;
            }
        };

        // ---- 解析 Segment，收集 Cluster 样本 ----
        const samples = [];
        let segmentStart = 0, segmentEnd = data.length;

        // 跳过 EBML 头部
        const ebmlEl = readElement(0);
        if (!ebmlEl || ebmlEl.id !== 0x1A45DFA3) throw new Error('不是有效的 WebM/EBML 文件');
        let pos = ebmlEl.end;

        // 查找 Segment
        const segEl = readElement(pos);
        if (!segEl || segEl.id !== 0x18538067) throw new Error('找不到 Segment');
        segmentStart = segEl.dataOffset;
        segmentEnd = segEl.end;

        // 第一遍：解析 Tracks + Info
        let sp = segmentStart;
        while (sp < segmentEnd) {
            const el = readElement(sp);
            if (!el || el.end > segmentEnd) break;
            if (el.id === 0x1654AE6B) parseTracks(el.dataOffset, el.end); // Tracks
            if (el.id === 0x1549A966) parseInfo(el.dataOffset, el.end);    // Info
            sp = el.end;
        }
        if (!videoTrack) throw new Error('WebM 无视频轨道');

        // 第二遍：解析 Clusters
        sp = segmentStart;
        while (sp < segmentEnd) {
            const el = readElement(sp);
            if (!el || el.end > segmentEnd) break;
            if (el.id === 0x1F43B675) { // Cluster
                parseCluster(el.dataOffset, el.end);
            }
            sp = el.end;
        }

        function parseCluster(co, ce) {
            let clusterTimecode = 0;
            let cp = co;

            // 先读 Cluster Timecode
            while (cp < ce) {
                const el = readElement(cp);
                if (!el || el.end > ce) break;
                if (el.id === 0xE7) { // Timecode
                    let v = 0; for (let i = 0; i < el.size; i++) v = (v << 8) | data[el.dataOffset + i];
                    clusterTimecode = v;
                }
                cp = el.end;
            }

            // 再读 SimpleBlock / BlockGroup
            cp = co;
            while (cp < ce) {
                const el = readElement(cp);
                if (!el || el.end > ce) break;

                const parseBlock = (blockOffset, blockSize, isSimple) => {
                    const bo = blockOffset;
                    const tnVint = readVint(bo);
                    if (!tnVint) return;
                    const tn = tnVint.value;
                    if (tn !== videoTrack.trackNum) return;

                    const tcOffset = tnVint.end;
                    if (tcOffset + 2 > bo + blockSize) return;
                    // int16 timecode (signed, relative to cluster timecode)
                    const relTc = (data[tcOffset] << 8 | data[tcOffset + 1]) << 16 >> 16; // sign-extend int16
                    const flags = tcOffset + 2 < bo + blockSize ? data[tcOffset + 2] : 0;
                    const isKey = !!(flags & 0x80);

                    const frameDataOffset = tcOffset + 3;
                    const frameSize = bo + blockSize - frameDataOffset;
                    if (frameSize <= 0) return;

                    const absTimecode = clusterTimecode + relTc; // 单位 = TimecodeScale
                    const timeSec = absTimecode * timecodeScale / 1e9; // 纳秒 → 秒

                    samples.push({
                        timeSec,
                        dtsSec: timeSec,
                        isKey,
                        data: data.slice(frameDataOffset, frameDataOffset + frameSize),
                        durationSec: 0, // 后续根据帧间隔推算
                    });
                };

                if (el.id === 0xA3) { // SimpleBlock
                    parseBlock(el.dataOffset, el.size, true);
                } else if (el.id === 0xA0) { // BlockGroup
                    // BlockGroup 内找 Block (0xA1)
                    let bgp = el.dataOffset;
                    while (bgp < el.end) {
                        const sub = readElement(bgp);
                        if (!sub || sub.end > el.end) break;
                        if (sub.id === 0xA1) { // Block
                            parseBlock(sub.dataOffset, sub.size, false);
                        }
                        bgp = sub.end;
                    }
                }
                cp = el.end;
            }
        }

        // ---- 推算 duration ----
        if (samples.length > 1) {
            // 根据帧间隔推算每帧 duration
            for (let i = 0; i < samples.length - 1; i++) {
                samples[i].durationSec = Math.max(0.001, samples[i + 1].timeSec - samples[i].timeSec);
            }
            samples[samples.length - 1].durationSec = samples[samples.length - 2]?.durationSec || 0.033;
        }

        // ---- 构建 codec 字符串 ----
        let codec = videoTrack.codecId;
        const isVP8 = codec === 'V_VP8';
        const isVP9 = codec === 'V_VP9';
        const isAV1 = codec === 'V_AV1';

        if (isVP8) codec = 'vp8';
        else if (isVP9) codec = getVP9CodecString(videoTrack.width || 1920, videoTrack.height || 1080, 30);
        else if (isAV1) {
            // 尝试从 CodecPrivate 提取 profile/level/tier
            const cp = videoTrack.codecPrivate;
            if (cp && cp.length >= 4) {
                const seqProfile = (cp[1] >> 5) & 0x07;        // byte 1 bits 7-5
                const seqLevelIdx0 = cp[1] & 0x1F;              // byte 1 bits 4-0
                const seqTier = (cp[2] >> 7) & 0x01;            // byte 2 bit 7
                codec = 'av01.' + seqProfile + '.' + (seqLevelIdx0 < 10 ? '0' : '') + seqLevelIdx0 + (seqTier ? 'H' : 'M') + '.08';
            } else {
                codec = 'av01.0.04M.08'; // 兜底
            }
        }

        const duration = videoTrack._duration || (samples.length > 0 ? samples[samples.length - 1].timeSec + samples[samples.length - 1].durationSec : 0);

        console.log('[WebMReader] 解析完成: ' + codec + ' ' + videoTrack.width + 'x' + videoTrack.height + ' ' + samples.length + ' 样本 ' + duration.toFixed(2) + 's');

        return {
            codec,
            width: videoTrack.width || 1920,
            height: videoTrack.height || 1080,
            duration,
            samples,
            codecDescription: videoTrack.codecPrivate, // VP8/VP9 可能为 null，AV1 必须
            _rawCodec: videoTrack.codecId,
            _isAVC: false,
            _isHEVC: false,
            _isVP8: isVP8,
            _isVP9: isVP9,
            _isAV1: isAV1,
        };
    }
};

// ============ 便捷工厂 ============

/**
 * 始终返回 Mp4Reader。由上层 try/catch 处理非 mp4 文件的自然失败。
 * 原始代码不按扩展名过滤——mp4box 解析失败自然会触发 <video> 回退。
 */
KiraExport.createContainerReader = function (url) {
    const ext = (url || '').split('.').pop().toLowerCase();
    if (ext === 'webm') return KiraExport.WebMReader;
    return KiraExport.Mp4Reader;  // mp4 及其他格式默认尝试 mp4box
};
