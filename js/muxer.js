// ==================== WebM Muxer（离线编码用，chunked 输出） ====================
function muxWebM(chunks, opts) {
    const blobParts = [];

    const makeBuf = () => {
        const w = [];
        const u8 = v => { w.push(v & 0xFF); };
        const u16be = v => { w.push((v>>>8)&0xFF, v&0xFF); };
        const u32be = v => { w.push((v>>>24)&0xFF, (v>>>16)&0xFF, (v>>>8)&0xFF, v&0xFF); };
        const f64be = v => {
            const b = new Uint8Array(new Float64Array([v]).buffer);
            for (let i = 7; i >= 0; i--) w.push(b[i]);
        };
        const raw = arr => { for (let b of arr) w.push(b); };
        const sstr = s => { for (let i = 0; i < s.length; i++) w.push(s.charCodeAt(i)); };
        function el(id, nBytes, dataFn) {
            if (nBytes===4) u32be(id); else if (nBytes===3) { u8((id>>>16)&0xFF); u8((id>>>8)&0xFF); u8(id&0xFF); } else if (nBytes===2) u16be(id); else u8(id);
            const pos = w.length; dataFn(); const size = w.length - pos;
            const sb = []; let sv = size;
            if (sv<0x7F) sb.push(0x80|sv);
            else if (sv<0x3FFF) sb.push(0x40|((sv>>>8)&0x3F), sv&0xFF);
            else if (sv<0x1FFFFF) sb.push(0x20|((sv>>>16)&0x1F), (sv>>>8)&0xFF, sv&0xFF);
            else sb.push(0x10|((sv>>>24)&0x0F), (sv>>>16)&0xFF, (sv>>>8)&0xFF, sv&0xFF);
            w.splice(pos, 0, ...sb);
        }
        const toU8 = () => new Uint8Array(w);
        return { w, u8, u16be, u32be, f64be, raw, sstr, el, toU8 };
    };

    // --- Header ---
    const h = makeBuf();
    h.el(0x1A45DFA3, 4, () => {
        h.el(0x4286,2,()=>h.u8(1)); h.el(0x42F7,2,()=>h.u8(1)); h.el(0x42F2,2,()=>h.u8(4));
        h.el(0x42F3,2,()=>h.u8(8)); h.el(0x4282,2,()=>h.sstr('webm')); h.el(0x4287,2,()=>h.u8(2)); h.el(0x4285,2,()=>h.u8(2));
    });
    h.u32be(0x18538067); h.u8(0x01); for (let i=0;i<7;i++) h.u8(0xFF);
    h.el(0x1549A966, 4, () => {
        h.el(0x2AD7B1,3,()=>{h.u8(0x0F);h.u8(0x42);h.u8(0x40);});
        h.el(0x4489,2,()=>h.f64be(opts.durationMs||0));
    });
    h.el(0x1654AE6B, 4, () => {
        h.el(0xAE,1,()=>{
            h.el(0xD7,1,()=>h.u8(1)); h.el(0x73C5,2,()=>h.u8(1)); h.el(0x83,1,()=>h.u8(1));
            h.el(0x86,1,()=>h.sstr(opts.codec==='vp8'?'V_VP8':'V_VP9'));
            h.el(0xE0,1,()=>{ h.el(0xB0,1,()=>{h.u16be(opts.width);}); h.el(0xBA,1,()=>{h.u16be(opts.height);}); });
        });
    });
    blobParts.push(h.toU8());

    // --- Clusters ---
    let ci = 0;
    while (ci < chunks.length) {
        const cStartMs = Math.floor(chunks[ci].timestamp/1000);
        const cEndMs = cStartMs + 30000;
        const cFrames = [];
        while (ci < chunks.length && Math.floor(chunks[ci].timestamp/1000) < cEndMs)
            cFrames.push({...chunks[ci], tMs: Math.floor(chunks[ci].timestamp/1000)-cStartMs, _ci: ci++});
        if (!cFrames.length) break;

        const c = makeBuf();
        c.el(0x1F43B675, 4, () => {
            const tcB = []; let tcv = cStartMs;
            if (tcv===0) tcB.push(0); else while(tcv>0){tcB.unshift(tcv&0xFF); tcv>>>=8;}
            c.el(0xE7,1,()=>{for(let b of tcB)c.u8(b);});
            for (const f of cFrames) {
                c.el(0xA3,1,()=>{ c.u8(0x81); c.u16be(f.tMs&0xFFFF); c.u8(f.isKey?0x80:0x00); c.raw(f.data); });
            }
        });
        blobParts.push(c.toU8());
    }

    return new Blob(blobParts, { type: 'video/webm' });
}
