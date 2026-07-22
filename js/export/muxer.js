// ==================== 第5层：Muxer（封装） ====================
// 依赖: ../muxer.js (muxWebM)

var KiraExport = window.KiraExport || {};

// --- WebM Muxer ---
KiraExport.WebMMuxer = {
    mux: function (chunks, opts) {
        return muxWebM(chunks, {
            width: opts.width,
            height: opts.height,
            codec: codecToMuxLabel(opts.codec),
            durationMs: opts.durationMs,
            fps: opts.fps,
            audioChunks: opts.audioChunks,
            audioSampleRate: opts.audioSampleRate,
            audioChannels: opts.audioChannels,
            audioDesc: opts.audioDesc,
        });
    }
};

// --- Mp4 Muxer ---
KiraExport.Mp4Muxer = {
    mux: function (videoChunks, opts) {
        if (typeof MP4Box === 'undefined') throw new Error('MP4Box 不可用');

        var w = opts.width || 1920;
        var h = opts.height || 1080;
        var fps = opts.fps || 60;
        var audioChunks = opts.audioChunks || [];
        var sampleRate = opts.audioSampleRate || 48000;
        var channels = opts.audioChannels || 2;

        var finalAvcC = opts.avcDesc;
        if (!finalAvcC) throw new Error('avcDesc 缺失');

        var file = MP4Box.createFile();
        var timescale = 1000000;
        var frameDuration = Math.round(timescale / fps);

        var toAB = function (u8) {
            if (!u8) return new ArrayBuffer(0);
            if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
            return u8.slice().buffer;
        };
        var toTicks = function (us) { return us; };

        // ---- 视频 track ----
        var videoTrackId = file.addTrack({
            width: w, height: h, timescale: timescale,
            avcDecoderConfigRecord: toAB(finalAvcC),
        });
        for (var i = 0; i < videoChunks.length; i++) {
            var ts = toTicks(videoChunks[i].timestamp);
            var dur;
            if (i + 1 < videoChunks.length) {
                dur = toTicks(videoChunks[i + 1].timestamp) - ts;
            } else {
                dur = i > 0
                    ? ts - toTicks(videoChunks[i - 1].timestamp)
                    : frameDuration;
            }
            file.addSample(videoTrackId, toAB(videoChunks[i].data), {
                duration: dur, dts: ts, cts: ts, is_sync: videoChunks[i].isKey,
            });
        }

        // ---- 音频 track ----
        var audioTrackId = null;
        if (audioChunks.length > 0) {
            audioTrackId = file.addTrack({
                timescale: sampleRate, samplerate: sampleRate,
                channel_count: channels, hdlr: 'soun', type: 'mp4a',
            });

            var audioConfig = new Uint8Array([
                0x03, 0x80, 0x80, 0x80, 0x22, 0x00, 0x00, 0x00,
                0x04, 0x80, 0x80, 0x80, 0x1A, 0x40, 0x15, 0x00, 0x00, 0x00,
                0x00, 0x01, 0xF4, 0x00, 0x00, 0x01, 0xF4, 0x00,
                0x05, 0x80, 0x80, 0x80, 0x02, 0x11, 0x90,
                0x06, 0x80, 0x80, 0x80, 0x01, 0x02,
            ]);
            var esds = new BoxParser.esdsBox();
            esds.type = 'esds';
            esds.data = audioConfig;

            var audioTrackObj = file.moov.traks.find(function (t) { return t.tkhd && t.tkhd.track_id === audioTrackId; });
            var mp4a = audioTrackObj.mdia.minf.stbl.stsd.entries[0];
            mp4a.boxes = [];
            mp4a.boxes.push(esds);

            for (var ai = 0; ai < audioChunks.length; ai++) {
                var cts = ai * 1024;
                file.addSample(audioTrackId, toAB(audioChunks[ai].data), {
                    duration: 1024, dts: cts, cts: cts, is_sync: true,
                });
            }
        }

        // MP4Box#getBuffer writes every box into one contiguous ArrayBuffer.
        // Keep its box generation, but serialize each box separately so large
        // exports never require one allocation as large as the complete file.
        var parts = [];
        for (var bi = 0; bi < file.boxes.length; bi++) {
            var box = file.boxes[bi];
            if (box.type === 'mdat' && box.data) {
                var payloadSize = box.data.byteLength;
                var totalSize = payloadSize + 8;
                var large = totalSize > 0xFFFFFFFF;
                var header = new Uint8Array(large ? 16 : 8);
                var view = new DataView(header.buffer);
                view.setUint32(0, large ? 1 : totalSize, false);
                header.set([0x6D, 0x64, 0x61, 0x74], 4); // "mdat"
                if (large) {
                    var largeSize = payloadSize + 16;
                    view.setUint32(8, Math.floor(largeSize / 0x100000000), false);
                    view.setUint32(12, largeSize >>> 0, false);
                }
                parts.push(header, box.data);
                continue;
            }

            var stream = new DataStream();
            stream.endianness = DataStream.BIG_ENDIAN;
            box.write(stream);
            parts.push(stream.buffer);
        }

        return new Blob(parts, { type: 'video/mp4' });
    }
};

// --- 便捷工厂 ---
KiraExport.createMuxer = function (format) {
    if (format === 'mp4') return KiraExport.Mp4Muxer;
    return KiraExport.WebMMuxer;
};
