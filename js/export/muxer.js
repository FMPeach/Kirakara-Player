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
        if (!videoChunks.length) throw new Error('视频编码数据为空');

        var file = MP4Box.createFile();
        file.init({ brands: ['isom', 'iso2', 'avc1', 'mp41'], timescale: 1000 });
        var timescale = 1000000;
        var frameDuration = Math.round(timescale / fps);

        var toAB = function (u8) {
            if (u8 instanceof ArrayBuffer) return u8;
            if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
            return u8.slice().buffer;
        };
        var writeBox = function (box) {
            var stream = new DataStream();
            stream.endianness = DataStream.BIG_ENDIAN;
            box.write(stream);
            return stream.buffer;
        };

        // ---- 视频 track ----
        var videoTrackId = file.addTrack({
            width: w, height: h, timescale: timescale,
            language: 'und',
            avcDecoderConfigRecord: toAB(finalAvcC),
        });

        // ---- 音频 track ----
        var audioTrackId = null;
        if (audioChunks.length > 0) {
            audioTrackId = file.addTrack({
                timescale: sampleRate, samplerate: sampleRate,
                channel_count: channels, hdlr: 'soun', type: 'mp4a',
                language: 'und',
            });

            // Use the encoder's AudioSpecificConfig, not a fixed 48 kHz stereo ASC.
            var asc = opts.audioDesc ? new Uint8Array(opts.audioDesc) : null;
            if (!asc || !asc.length) {
                var rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
                var rateIndex = rates.indexOf(sampleRate);
                if (rateIndex < 0) throw new Error('AAC 配置缺失，无法确定采样率');
                var configBits = (2 << 11) | (rateIndex << 7) | (channels << 3);
                asc = new Uint8Array([configBits >> 8, configBits & 0xFF]);
            }
            var descriptor = function (tag, data) {
                var size = data.length;
                var lengthBytes = [size & 0x7F];
                while ((size = Math.floor(size / 128)) > 0) lengthBytes.unshift((size & 0x7F) | 0x80);
                return [tag].concat(lengthBytes, Array.from(data));
            };
            var decoderConfig = [0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
                .concat(descriptor(0x05, asc));
            var audioConfig = new Uint8Array(descriptor(0x03,
                [audioTrackId >> 8, audioTrackId & 0xFF, 0]
                    .concat(descriptor(0x04, decoderConfig), descriptor(0x06, [0x02]))));
            var esds = new BoxParser.esdsBox();
            esds.version = 0;
            esds.flags = 0;
            esds.data = audioConfig;

            file.getTrackById(audioTrackId).mdia.minf.stbl.stsd.entries[0].addBox(esds);
        }

        // addSample() in MP4Box 0.5.2 always creates moof/mdat pairs. Populate
        // ordinary sample tables instead; the encoded payload stays untouched.
        file.moov.boxes = file.moov.boxes.filter(function (box) { return box.type !== 'mvex'; });
        delete file.moov.mvex;
        var payloadSize = 0;
        var prepareTrack = function (trackId, chunks, isVideo) {
            var track = file.getTrackById(trackId);
            var stbl = track.mdia.minf.stbl;
            var syncSamples = isVideo ? stbl.add('stss') : null;
            if (syncSamples) syncSamples.sample_numbers = [];
            var duration = 0;
            for (var i = 0; i < chunks.length; i++) {
                var delta = 1024;
                if (isVideo) {
                    delta = i + 1 < chunks.length ? chunks[i + 1].timestamp - chunks[i].timestamp
                        : i > 0 ? chunks[i].timestamp - chunks[i - 1].timestamp : frameDuration;
                }
                if (!Number.isInteger(delta) || delta <= 0 || delta > 0xFFFFFFFF) {
                    throw new Error('编码数据的样本时长无效');
                }
                var last = stbl.stts.sample_deltas.length - 1;
                if (last >= 0 && stbl.stts.sample_deltas[last] === delta) stbl.stts.sample_counts[last]++;
                else {
                    stbl.stts.sample_counts.push(1);
                    stbl.stts.sample_deltas.push(delta);
                }
                var size = chunks[i].data.byteLength;
                if (!Number.isInteger(size) || size <= 0 || size > 0xFFFFFFFF) {
                    throw new Error('编码数据的样本大小无效');
                }
                stbl.stsz.sample_sizes.push(size);
                stbl.stco.chunk_offsets.push(0);
                if (syncSamples && chunks[i].isKey) syncSamples.sample_numbers.push(i + 1);
                duration += delta;
                payloadSize += size;
            }
            stbl.stsc.first_chunk = [1];
            stbl.stsc.samples_per_chunk = [1];
            stbl.stsc.sample_description_index = [1];
            var mdhd = track.mdia.mdhd;
            mdhd.duration = duration;
            mdhd.language = 0x55C4; // "und"
            // The bundled writer only implements mdhd v0. Preserve microsecond
            // timestamps while allowing videos longer than its 32-bit duration.
            if (duration > 0xFFFFFFFF) mdhd.write = function (stream) {
                this.version = 1;
                this.flags = 0;
                this.size = 32;
                this.writeHeader(stream);
                stream.writeUint64(this.creation_time);
                stream.writeUint64(this.modification_time);
                stream.writeUint32(this.timescale);
                stream.writeUint64(this.duration);
                stream.writeUint16(this.language);
                stream.writeUint16(0);
            };
            track.tkhd.duration = Math.ceil(duration * file.moov.mvhd.timescale / mdhd.timescale);
            track.tkhd.matrix = file.moov.mvhd.matrix.slice();
            track.tkhd.volume = isVideo ? 0 : 1;
            if (!isVideo) track.tkhd.width = track.tkhd.height = 0;
            return { track: track, offsets: stbl.stco.chunk_offsets };
        };
        var video = prepareTrack(videoTrackId, videoChunks, true);
        var audio = audioTrackId !== null ? prepareTrack(audioTrackId, audioChunks, false) : null;
        file.moov.mvhd.duration = Math.max(video.track.tkhd.duration, audio ? audio.track.tkhd.duration : 0);
        file.moov.mvhd.volume = audio ? 1 : 0;

        var large = payloadSize + 8 > 0xFFFFFFFF;
        var header = new Uint8Array(large ? 16 : 8);
        var view = new DataView(header.buffer);
        view.setUint32(0, large ? 1 : payloadSize + 8, false);
        header.set([0x6D, 0x64, 0x61, 0x74], 4); // "mdat"
        if (large) {
            var largeSize = payloadSize + 16;
            view.setUint32(8, Math.floor(largeSize / 0x100000000), false);
            view.setUint32(12, largeSize >>> 0, false);
        }

        // Size only the small metadata first, then resolve fast-start offsets.
        // Use 64-bit chunk offsets when a complete file can exceed 4 GiB.
        var ftyp = writeBox(file.ftyp);
        var moov = writeBox(file.moov);
        if (ftyp.byteLength + moov.byteLength + header.byteLength + payloadSize > 0xFFFFFFFF) {
            [video, audio].filter(Boolean).forEach(function (entry) {
                var stbl = entry.track.mdia.minf.stbl;
                var co64 = new BoxParser.co64Box();
                co64.chunk_offsets = entry.offsets;
                stbl.boxes[stbl.boxes.indexOf(stbl.stco)] = co64;
                delete stbl.stco;
                stbl.co64 = co64;
            });
            moov = writeBox(file.moov);
        }

        // Interleave the already-encoded video/AAC samples without concatenating
        // their bytes into one giant ArrayBuffer or changing their timestamps.
        var parts = [ftyp, null, header];
        var offset = ftyp.byteLength + moov.byteLength + header.byteLength;
        var vi = 0, ai = 0;
        var firstVideoTimestamp = videoChunks[0].timestamp;
        while (vi < videoChunks.length || ai < audioChunks.length) {
            if (vi < videoChunks.length && (ai >= audioChunks.length
                    || videoChunks[vi].timestamp - firstVideoTimestamp <= ai * 1024 * timescale / sampleRate)) {
                video.offsets[vi] = offset;
                parts.push(videoChunks[vi].data);
                offset += videoChunks[vi++].data.byteLength;
            } else {
                audio.offsets[ai] = offset;
                parts.push(audioChunks[ai].data);
                offset += audioChunks[ai++].data.byteLength;
            }
        }
        parts[1] = writeBox(file.moov);
        return new Blob(parts, { type: 'video/mp4' });
    }
};

// --- 便捷工厂 ---
KiraExport.createMuxer = function (format) {
    if (format === 'mp4') return KiraExport.Mp4Muxer;
    return KiraExport.WebMMuxer;
};
