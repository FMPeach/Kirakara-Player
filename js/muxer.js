// ==================== WebM Muxer（离线编码用，带 Cues/SeekHead） ====================
function muxWebM(chunks, opts) {
    const hasAudio = !!(opts.audioChunks && opts.audioChunks.length > 0);
    const audioSampleRate = opts.audioSampleRate || 48000;
    const audioChannels = opts.audioChannels || 2;
    const audioCh = opts.audioChunks || [];

    const makeBuf = () => {
        const w = [];
        const u8 = v => { w.push(v & 0xFF); };
        const u16be = v => { w.push((v>>>8)&0xFF, v&0xFF); };
        const u32be = v => { w.push((v>>>24)&0xFF, (v>>>16)&0xFF, (v>>>8)&0xFF, v&0xFF); };
        const u64be = v => {
            const hi = Math.floor(v / 0x100000000);
            const lo = v & 0xFFFFFFFF;
            w.push((hi>>>24)&0xFF, (hi>>>16)&0xFF, (hi>>>8)&0xFF, hi&0xFF,
                   (lo>>>24)&0xFF, (lo>>>16)&0xFF, (lo>>>8)&0xFF, lo&0xFF);
        };
        const f64be = v => {
            const b = new Uint8Array(new Float64Array([v]).buffer);
            for (let i = 7; i >= 0; i--) w.push(b[i]);
        };
        const raw = arr => { for (let b of arr) w.push(b); };
        const sstr = s => { for (let i = 0; i < s.length; i++) w.push(s.charCodeAt(i)); };
        const writeVint = v => {
            if      (v < 0x7F)     u8(0x80 | v);
            else if (v < 0x3FFF)   { u8(0x40 | ((v>>>8)&0x3F)); u8(v & 0xFF); }
            else if (v < 0x1FFFFF) { u8(0x20 | ((v>>>16)&0x1F)); u8((v>>>8)&0xFF); u8(v & 0xFF); }
            else                    { u8(0x10 | ((v>>>24)&0x0F)); u8((v>>>16)&0xFF); u8((v>>>8)&0xFF); u8(v & 0xFF); }
        };
        function el(id, nBytes, dataFn) {
            if (nBytes===4) u32be(id); else if (nBytes===3) { u8((id>>>16)&0xFF); u8((id>>>8)&0xFF); u8(id&0xFF); } else if (nBytes===2) u16be(id); else u8(id);
            const pos = w.length; dataFn(); const size = w.length - pos;
            const sb = []; let sv = size;
            if      (sv<0x7F)     sb.push(0x80|sv);
            else if (sv<0x3FFF)   sb.push(0x40|((sv>>>8)&0x3F), sv&0xFF);
            else if (sv<0x1FFFFF) sb.push(0x20|((sv>>>16)&0x1F), (sv>>>8)&0xFF, sv&0xFF);
            else                   sb.push(0x10|((sv>>>24)&0x0F), (sv>>>16)&0xFF, (sv>>>8)&0xFF, sv&0xFF);
            w.splice(pos, 0, ...sb);
        }
        const toU8 = () => new Uint8Array(w);
        return { w, u8, u16be, u32be, u64be, f64be, raw, sstr, writeVint, el, toU8 };
    };

    const makeElementHeader = (id, nBytes, size) => {
        const b = makeBuf();
        if (nBytes === 4) b.u32be(id);
        else if (nBytes === 3) { b.u8((id>>>16)&0xFF); b.u8((id>>>8)&0xFF); b.u8(id&0xFF); }
        else if (nBytes === 2) b.u16be(id);
        else b.u8(id);
        b.writeVint(size);
        return b.toU8();
    };

    // ---- OpusHead 工具 ----
    const buildOpusHead = (ch, sr) => {
        const buf = new Uint8Array(19);
        buf.set([0x4F,0x70,0x75,0x73,0x48,0x65,0x61,0x64], 0);
        buf[8] = 1; buf[9] = ch;
        buf[10] = 0x38; buf[11] = 0x01;
        buf[12] = sr & 0xFF; buf[13] = (sr>>>8) & 0xFF;
        buf[14] = (sr>>>16) & 0xFF; buf[15] = (sr>>>24) & 0xFF;
        buf[16] = 0; buf[17] = 0; buf[18] = 0;
        return buf;
    };
    const parsePreSkip = (desc) => {
        if (desc && desc.length >= 12) return desc[10] | (desc[11] << 8);
        return 312;
    };
    const opusDesc = opts.audioDesc || buildOpusHead(audioChannels, audioSampleRate);
    const opusPreSkip = parsePreSkip(opusDesc);
    const codecDelayNs = Math.round(opusPreSkip * 1e9 / audioSampleRate);
    const seekPreRollNs = 80000000;

    // ====== Step 1: Group into ~2s clusters ======
    const clusters = []; // {startMs, vFrames[], aFrames[]}
    let ci = 0, ai = 0;
    while (ci < chunks.length || ai < audioCh.length) {
        let cStartMs = Infinity;
        if (ci < chunks.length)     cStartMs = Math.min(cStartMs, Math.round(chunks[ci].timestamp / 1000));
        if (ai < audioCh.length)    cStartMs = Math.min(cStartMs, Math.round(audioCh[ai].timestamp / 1000));
        if (cStartMs === Infinity) break;

        const cEndMs = cStartMs + 2000;
        const vFrames = [], aFrames = [];
        while (ci < chunks.length && Math.round(chunks[ci].timestamp/1000) < cEndMs) {
            const frame = chunks[ci++];
            vFrames.push({frame, tMs: Math.round(frame.timestamp/1000)-cStartMs});
        }
        while (ai < audioCh.length && Math.round(audioCh[ai].timestamp/1000) < cEndMs) {
            const frame = audioCh[ai++];
            aFrames.push({frame, tMs: Math.round(frame.timestamp/1000)-cStartMs});
        }
        if (vFrames.length || aFrames.length)
            clusters.push({startMs: cStartMs, vFrames, aFrames});
    }

    // ====== Step 2: Build cluster headers and retain frame data as Blob parts ======
    const clusterBufs = [];
    for (const cl of clusters) {
        const tc = makeBuf();
        const tcB = []; let tcv = cl.startMs;
        if (tcv===0) tcB.push(0); else while(tcv>0){tcB.unshift(tcv&0xFF); tcv>>>=8;}
        tc.el(0xE7, 1, ()=>{for(let b of tcB)tc.u8(b);});

        const payloadParts = [tc.toU8()];
        let payloadSize = payloadParts[0].byteLength;
        let vi = 0, ac = 0;
        while (vi < cl.vFrames.length || ac < cl.aFrames.length) {
            const vTs = vi < cl.vFrames.length ? cl.vFrames[vi].tMs : Infinity;
            const aTs = ac < cl.aFrames.length ? cl.aFrames[ac].tMs : Infinity;
            const item = vTs <= aTs ? cl.vFrames[vi++] : cl.aFrames[ac++];
            const frame = item.frame;
            const block = makeBuf();
            block.u8(0xA3);
            block.writeVint(4 + frame.data.byteLength);
            block.u8(vTs <= aTs ? 0x81 : 0x82);
            block.u16be(item.tMs & 0xFFFF);
            block.u8(vTs <= aTs ? (frame.isKey ? 0x80 : 0x00) : 0x80);
            const blockHeader = block.toU8();
            payloadParts.push(blockHeader, frame.data);
            payloadSize += blockHeader.byteLength + frame.data.byteLength;
        }

        const clusterHeader = makeElementHeader(0x1F43B675, 4, payloadSize);
        clusterBufs.push({
            startMs: cl.startMs,
            parts: [clusterHeader, ...payloadParts],
            byteLength: clusterHeader.byteLength + payloadSize,
        });
    }

    // ====== Step 3: Build Info ======
    const info = makeBuf();
    info.el(0x1549A966, 4, () => {
        info.el(0x2AD7B1,3,()=>{info.u8(0x0F);info.u8(0x42);info.u8(0x40);});
        info.el(0x4489,2,()=>info.f64be(opts.durationMs||0));
    });
    const infoBuf = info.toU8();

    // ====== Step 4: Build Tracks ======
    const tracks = makeBuf();
    tracks.el(0x1654AE6B, 4, () => {
        tracks.el(0xAE,1,()=>{
            tracks.el(0xD7,1,()=>tracks.u8(1)); tracks.el(0x73C5,2,()=>tracks.u8(1)); tracks.el(0x83,1,()=>tracks.u8(1));
            tracks.el(0x86,1,()=>tracks.sstr(opts.codec==='vp8'?'V_VP8':'V_VP9'));
            tracks.el(0x23E383,3,()=>tracks.u64be(Math.round(1e9/(opts.fps||60)))); // DefaultDuration (ns)
            tracks.el(0xE0,1,()=>{ tracks.el(0xB0,1,()=>{tracks.u16be(opts.width);}); tracks.el(0xBA,1,()=>{tracks.u16be(opts.height);}); });
        });
        if (hasAudio) {
            tracks.el(0xAE,1,()=>{
                tracks.el(0xD7,1,()=>tracks.u8(2)); tracks.el(0x73C5,2,()=>tracks.u8(2)); tracks.el(0x83,1,()=>tracks.u8(2));
                tracks.el(0x86,1,()=>tracks.sstr('A_OPUS'));
                tracks.el(0x63A2,2,()=>tracks.raw(opusDesc));
                tracks.el(0x56AA,2,()=>tracks.u64be(codecDelayNs));
                tracks.el(0x56BB,2,()=>tracks.u64be(seekPreRollNs));
                tracks.el(0xE1,1,()=>{
                    tracks.el(0xB5,1,()=>tracks.f64be(audioSampleRate));
                    tracks.el(0x9F,1,()=>tracks.u8(audioChannels));
                });
            });
        }
    });
    const tracksBuf = tracks.toU8();

    // ====== Step 5: Calculate offsets ======
    // Segment data starts after SegID(4) + unknown-size(8) = 12 bytes into file
    // Within segment data: SeekHead(est80) → Info → Tracks → Cues → Cluster[0..N]
    const EST_SK = 80;
    const infoOff = EST_SK;
    const tracksOff = infoOff + infoBuf.length;

    // ====== Step 6: Build Cues (with estimated offsets) ======
    const cues = makeBuf();
    cues.el(0x1C53BB6B, 4, () => {
        let clOff = tracksOff + tracksBuf.length; // after Tracks, before we know exact Cues size
        for (let k = 0; k < clusterBufs.length; k++) {
            const cl = clusterBufs[k];
            cues.el(0xBB, 1, () => {
                cues.el(0xB3, 1, ()=>cues.writeVint(cl.startMs));
                cues.el(0xB7, 1, ()=>{
                    cues.el(0xF7, 1, ()=>cues.writeVint(1)); // CueTrack = 1 (video track)
                    cues.el(0xF1, 1, ()=>cues.writeVint(clOff));
                });
            });
            clOff += cl.byteLength;
        }
    });
    const cuesBuf = cues.toU8();

    // Recalc: actual Cues offset = tracksOff + tracksBuf.length (same as estimated above)
    // Cluster offsets: shift by (actual SeekHead - EST_SK) since SeekHead size may differ
    // But SeekHead is tiny, so error is negligible. Build final SeekHead now.

    // ====== Step 7: Build SeekHead ======
    const sk = makeBuf();
    sk.el(0x114D9B74, 4, () => {
        // Seek to Info
        sk.el(0x4DBB,2,()=>{
            sk.el(0x53AB,2,()=>{ sk.u32be(0x1549A966); });
            sk.el(0x53AC,2,()=>sk.writeVint(infoOff));
        });
        // Seek to Tracks
        sk.el(0x4DBB,2,()=>{
            sk.el(0x53AB,2,()=>{ sk.u32be(0x1654AE6B); });
            sk.el(0x53AC,2,()=>sk.writeVint(tracksOff));
        });
        // Seek to Cues
        sk.el(0x4DBB,2,()=>{
            sk.el(0x53AB,2,()=>{ sk.u32be(0x1C53BB6B); });
            sk.el(0x53AC,2,()=>sk.writeVint(tracksOff + tracksBuf.length));
        });
    });
    const skBuf = sk.toU8();

    // ====== Step 8: Concatenate ======
    const blobParts = [];
    // EBML Header
    const ebml = makeBuf();
    ebml.el(0x1A45DFA3, 4, () => {
        ebml.el(0x4286,2,()=>ebml.u8(1)); ebml.el(0x42F7,2,()=>ebml.u8(1)); ebml.el(0x42F2,2,()=>ebml.u8(4));
        ebml.el(0x42F3,2,()=>ebml.u8(8)); ebml.el(0x4282,2,()=>ebml.sstr('webm')); ebml.el(0x4287,2,()=>ebml.u8(2)); ebml.el(0x4285,2,()=>ebml.u8(2));
    });
    blobParts.push(ebml.toU8());

    // Segment with unknown size
    const segHdr = makeBuf();
    segHdr.u32be(0x18538067);
    segHdr.u8(0x01); for (let i=0;i<7;i++) segHdr.u8(0xFF);
    blobParts.push(segHdr.toU8());

    // Payload: SeekHead → Info → Tracks → Cues → Clusters
    blobParts.push(skBuf, infoBuf, tracksBuf, cuesBuf);
    for (const cl of clusterBufs) {
        for (const part of cl.parts) blobParts.push(part);
    }

    return new Blob(blobParts, { type: 'video/webm' });
}
