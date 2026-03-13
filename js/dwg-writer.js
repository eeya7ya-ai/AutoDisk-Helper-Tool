/**
 * DWGWriter - Generates AutoCAD DWG R2000 (AC1015) binary files.
 *
 * Implements the DWG R2000 bit-stream format with support for:
 * LINE, CIRCLE, ARC, LWPOLYLINE, TEXT entities.
 *
 * File structure:
 *   [File Header]  - version "AC1015" + section locators
 *   [Section 0]    - HEADER VARS  (drawing settings)
 *   [Section 1]    - CLASSES      (empty)
 *   [Section 2]    - OBJECTS      (entity data)
 *   [Section 3]    - UNKNOWN      (empty padding)
 *   [Section 4]    - OBJECT MAP   (handle → offset table)
 */

// ── CRC-16 used by DWG (polynomial 0xA001, reflected CRC-16/ARC) ─────────────
function dwgCRC16(data, seed) {
    let crc = (seed === undefined) ? 0xC0C1 : seed;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            if (crc & 1) crc = (crc >>> 1) ^ 0xA001;
            else         crc >>>= 1;
        }
    }
    return crc & 0xFFFF;
}

// ── Bit-stream writer for DWG compressed data ─────────────────────────────────
class BitStream {
    constructor(capacity) {
        this._buf    = new Uint8Array(capacity || 8192);
        this._len    = 0;   // bytes written
        this._bitVal = 0;   // pending bits (MSB-first accumulator)
        this._bitCnt = 0;   // how many bits are pending
    }

    _grow() {
        const n = new Uint8Array(this._buf.length * 2);
        n.set(this._buf);
        this._buf = n;
    }

    // Write a single bit (v = 0 or 1), MSB first within each byte
    _bit(v) {
        this._bitVal = (this._bitVal << 1) | (v & 1);
        if (++this._bitCnt === 8) {
            if (this._len >= this._buf.length - 1) this._grow();
            this._buf[this._len++] = this._bitVal & 0xFF;
            this._bitVal = 0;
            this._bitCnt = 0;
        }
    }

    // Write n bits from value (MSB first)
    _bits(value, n) {
        for (let i = n - 1; i >= 0; i--) this._bit((value >> i) & 1);
    }

    // Flush partial byte (pad low bits with 0)
    flush() {
        if (this._bitCnt > 0) {
            if (this._len >= this._buf.length - 1) this._grow();
            this._buf[this._len++] = (this._bitVal << (8 - this._bitCnt)) & 0xFF;
            this._bitVal = 0;
            this._bitCnt = 0;
        }
    }

    // ── Raw types (byte-aligned; flush pending bits first) ────────────────────

    RC(v) {   // Raw Char  (8-bit)
        this.flush();
        if (this._len >= this._buf.length - 1) this._grow();
        this._buf[this._len++] = v & 0xFF;
    }

    RS(v) {   // Raw Short (16-bit LE)
        this.RC(v & 0xFF);
        this.RC((v >> 8) & 0xFF);
    }

    RL(v) {   // Raw Long  (32-bit LE)
        this.RS(v & 0xFFFF);
        this.RS((v >>> 16) & 0xFFFF);
    }

    RD(v) {   // Raw Double (64-bit LE IEEE 754)
        this.flush();
        const dv = new DataView(new ArrayBuffer(8));
        dv.setFloat64(0, v, true);
        for (let i = 0; i < 8; i++) {
            if (this._len >= this._buf.length - 1) this._grow();
            this._buf[this._len++] = dv.getUint8(i);
        }
    }

    // ── Bit-encoded types ─────────────────────────────────────────────────────

    B(v) {   // Bit (1 bit)
        this._bit(v ? 1 : 0);
    }

    BB(v) {  // 2-bit value
        this._bits(v & 3, 2);
    }

    BS(v) {  // Bit Short
        v = v & 0xFFFF;
        if      (v === 0)   this._bits(0b10, 2);
        else if (v === 256) this._bits(0b11, 2);
        else if (v < 256)   { this._bits(0b01, 2); this._bits(v, 8); }
        else                { this._bits(0b00, 2); this._bits(v, 16); }
    }

    BL(v) {  // Bit Long
        v = v >>> 0;
        if      (v === 0) this._bits(0b10, 2);
        else if (v < 256) { this._bits(0b01, 2); this._bits(v, 8); }
        else              { this._bits(0b00, 2); this._bits(v, 32); }
    }

    BD(v) {  // Bit Double
        if      (v === 0.0) { this._bits(0b10, 2); }
        else if (v === 1.0) { this._bits(0b01, 2); }
        else {
            this._bits(0b00, 2);
            const dv = new DataView(new ArrayBuffer(8));
            dv.setFloat64(0, v, true);
            for (let i = 0; i < 8; i++) this._bits(dv.getUint8(i), 8);
        }
    }

    BD2(x, y)    { this.BD(x); this.BD(y); }
    BD3(x, y, z) { this.BD(x); this.BD(y); this.BD(z); }

    TV(s) {  // Text Value: BS length + raw bytes
        const str = (s == null) ? '' : String(s);
        this.BS(str.length);
        for (let i = 0; i < str.length; i++) this.RC(str.charCodeAt(i) & 0xFF);
    }

    // Handle: (code<<4 | byteCount) + handle bytes (big-endian)
    H(code, val) {
        val = (val >>> 0);
        if (val === 0) {
            this.RC((code & 0xF) << 4);  // 0 bytes for value
            return;
        }
        let cnt = 0, tmp = val;
        do { cnt++; tmp >>>= 8; } while (tmp > 0);
        this.RC(((code & 0xF) << 4) | (cnt & 0xF));
        for (let i = cnt - 1; i >= 0; i--) this.RC((val >>> (i * 8)) & 0xFF);
    }

    // Modular Char (LEB128-style, 7 bits/byte, high bit = more bytes)
    MC(v) {
        v = v >>> 0;
        do {
            let b = v & 0x7F;
            v >>>= 7;
            if (v > 0) b |= 0x80;
            this.RC(b);
        } while (v > 0);
    }

    // Modular Short (similar to MC but 2-byte min)
    MS(v) {
        v = v & 0xFFFF;
        if (v < 0x8000) {
            this.RC(v & 0xFF);
            this.RC((v >> 8) & 0xFF);
        } else {
            this.RC((v | 0x80) & 0xFF);
            this.RC((v >> 7) & 0xFF);
        }
    }

    toBytes() {
        this.flush();
        return this._buf.slice(0, this._len);
    }

    get byteLength() {
        this.flush();
        return this._len;
    }
}

// ── DWGWriter ─────────────────────────────────────────────────────────────────
class DWGWriter {

    constructor() {
        this.entities = [];
        this.layers   = new Map();
        this._hSeq    = 10;   // entity handles start at 10
        this._minX    =  Infinity;
        this._maxX    = -Infinity;
        this._minY    =  Infinity;
        this._maxY    = -Infinity;

        // Pre-defined layer handles (low values, same set as DXFWriter)
        const STD_LAYERS = [
            ['0',                 7],
            ['Walls',             1],
            ['Boundaries',        3],
            ['Furniture',         5],
            ['Text',              4],
            ['Dimensions',        6],
            ['Detected_Lines',    1],
            ['Detected_Contours', 3],
            ['Detected_Text',     4],
        ];
        let lh = 1;
        for (const [name, color] of STD_LAYERS) {
            this.layers.set(name, { name, color, handle: lh++ });
        }
    }

    _nextHandle() { return this._hSeq++; }

    _extBounds(x, y) {
        if (x < this._minX) this._minX = x;
        if (x > this._maxX) this._maxX = x;
        if (y < this._minY) this._minY = y;
        if (y > this._maxY) this._maxY = y;
    }

    // ── Public API (mirrors DXFWriter) ────────────────────────────────────────

    addLine(x1, y1, x2, y2, layer) {
        layer = layer || '0';
        this._extBounds(x1, y1); this._extBounds(x2, y2);
        this.entities.push({ type: 'LINE', layer, x1, y1, x2, y2, handle: this._nextHandle() });
    }

    addPolyline(points, layer, closed) {
        layer  = layer  || '0';
        closed = closed || false;
        if (!points || points.length < 2) return;
        for (const p of points) this._extBounds(p[0], p[1]);
        this.entities.push({ type: 'LWPOLYLINE', layer, points, closed, handle: this._nextHandle() });
    }

    addCircle(cx, cy, radius, layer) {
        layer = layer || '0';
        this._extBounds(cx - radius, cy - radius);
        this._extBounds(cx + radius, cy + radius);
        this.entities.push({ type: 'CIRCLE', layer, cx, cy, radius, handle: this._nextHandle() });
    }

    addArc(cx, cy, radius, startAngle, endAngle, layer) {
        layer = layer || '0';
        this._extBounds(cx - radius, cy - radius);
        this._extBounds(cx + radius, cy + radius);
        this.entities.push({ type: 'ARC', layer, cx, cy, radius, startAngle, endAngle, handle: this._nextHandle() });
    }

    addText(text, x, y, height, rotation, layer) {
        layer    = layer    || '0';
        height   = height   || 2.5;
        rotation = rotation || 0;
        this._extBounds(x, y);
        this.entities.push({ type: 'TEXT', layer, text, x, y, height, rotation, handle: this._nextHandle() });
    }

    addMText(text, x, y, width, height, layer) {
        this.addText(text, x, y, height || 2.5, 0, layer || '0');
    }

    addRectangle(x, y, w, h, layer) {
        this.addPolyline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], layer || '0', true);
    }

    getStats() {
        const s = { total: this.entities.length };
        for (const e of this.entities) s[e.type] = (s[e.type] || 0) + 1;
        return s;
    }

    // ── Binary generation ─────────────────────────────────────────────────────

    generate() {
        if (!isFinite(this._minX)) {
            this._minX = 0; this._maxX = 297;
            this._minY = 0; this._maxY = 210;
        }

        // Build sections (sections 0-4)
        const secHdrVars = this._buildHeaderVarsSection();
        const secClasses = this._buildClassesSection();
        const secObjs    = this._buildObjectsSection();
        const secUnknown = new Uint8Array(0);
        const secObjMap  = this._buildObjectMapSection();

        const sections = [secHdrVars, secClasses, secObjs, secUnknown, secObjMap];

        // DWG R2000 (AC1015) File Header — exact byte layout per ODA spec:
        //   0x00-0x05  "AC1015"          version string  (6 bytes)
        //   0x06-0x0B  0x00 × 6          reserved zeros  (6 bytes)
        //   0x0C       0x01              reserved byte   (1 byte)
        //   0x0D-0x10  image seeker RL   no thumbnail=0  (4 bytes)
        //   0x11-0x12  unknown RS        zeros           (2 bytes)
        //   0x13-0x14  code page RS      30=ANSI_1252    (2 bytes)
        //   0x15-0x18  section count RL  5               (4 bytes)
        //   0x19-0x45  5 × locator rec   each=RC+RL+RL   (45 bytes)
        //   0x46-0x47  CRC-16 RS         seed=0xC0C1     (2 bytes)
        //   Total = 0x48 = 72 bytes
        const HEADER_SIZE = 72;
        let offset = HEADER_SIZE;
        const seeks = [];
        for (const sec of sections) {
            seeks.push(offset);
            offset += sec.length;
        }

        const buf = new Uint8Array(offset);
        const dv  = new DataView(buf.buffer);

        // ── Write file header ──
        const VER = 'AC1015';
        for (let i = 0; i < 6; i++) buf[i] = VER.charCodeAt(i);
        // 0x06-0x0B: six reserved zeros (already zeroed)
        // 0x0C: reserved byte = 0x01
        buf[0x0C] = 0x01;
        // 0x0D-0x10: image seeker = 0 (no thumbnail)
        dv.setUint32(0x0D, 0, true);
        // 0x11-0x12: unknown = 0
        dv.setUint16(0x11, 0, true);
        // 0x13-0x14: code page = 30 (ANSI 1252)
        dv.setUint16(0x13, 30, true);
        // 0x15-0x18: number of section locators = 5
        dv.setUint32(0x15, 5, true);
        // 0x19-0x45: section locator records (5 × 9 bytes)
        for (let i = 0; i < 5; i++) {
            const base = 0x19 + i * 9;
            buf[base]     = i;                                       // section type (RC)
            dv.setUint32(base + 1, seeks[i],             true);     // seek (RL)
            dv.setUint32(base + 5, sections[i].length,   true);     // size (RL)
        }
        // 0x46-0x47: CRC-16 of bytes 0x00..0x45, seed=0xC0C1
        const hCRC = dwgCRC16(buf.subarray(0, 0x46));
        dv.setUint16(0x46, hCRC, true);

        // ── Copy sections ──
        let pos = HEADER_SIZE;
        for (const sec of sections) {
            buf.set(sec, pos);
            pos += sec.length;
        }

        return buf;
    }

    // Wrap a data buffer in the standard DWG R2000 section envelope:
    //   sentinel(16) + dataSize(RL) + data + CRC16(RS) + ~sentinel(16)
    _wrapSection(typeIdx, data) {
        // Known start sentinels per section type (from OpenDWG/LibreDWG spec)
        // Start sentinels per section type (LibreDWG / ODA spec).
        // End sentinel = bitwise complement of start (applied in code below).
        const STARTS = [
            [0xCF,0x7B,0x1F,0x23,0xFD,0xDE,0x38,0xA9,0x5F,0x7C,0x68,0xB8,0x4E,0x6D,0x33,0x5F], // 0: HEADER VARS
            [0x8D,0xA1,0xC4,0xB8,0xC4,0xA9,0xF8,0xC5,0xC0,0xDC,0xF4,0x5F,0xE7,0xCF,0xB6,0x8A], // 1: CLASSES
            [0xFC,0x4D,0x0D,0x07,0xE5,0x6A,0xAD,0x31,0x4D,0x12,0xAE,0xE9,0x41,0xC6,0xE6,0x07], // 2: OBJECTS
            [0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00], // 3: UNKNOWN
            [0x17,0xEA,0xE4,0xE4,0xC4,0x03,0x36,0x10,0xB9,0x43,0x4D,0x9E,0x97,0xB0,0x37,0x03], // 4: AUX HEADER
        ];
        const startSent = new Uint8Array(STARTS[typeIdx] || STARTS[0]);
        const endSent   = startSent.map(b => (~b) & 0xFF);  // bitwise complement

        const crc  = dwgCRC16(data);
        const size = 16 + 4 + data.length + 2 + 16;
        const out  = new Uint8Array(size);
        const dv   = new DataView(out.buffer);
        let   pos  = 0;

        out.set(startSent, pos);    pos += 16;
        dv.setUint32(pos, data.length, true); pos += 4;
        out.set(data, pos);         pos += data.length;
        dv.setUint16(pos, crc, true);          pos += 2;
        out.set(endSent, pos);

        return out;
    }

    // ── Section 0: HEADER VARS ────────────────────────────────────────────────
    _buildHeaderVarsSection() {
        const bs = new BitStream();

        // $ACADVER
        bs.TV('AC1015');
        // $ACADMAINTVER
        bs.BS(6);
        // $DWGCODEPAGE
        bs.TV('ANSI_1252');
        // $INSBASE
        bs.BD3(0, 0, 0);
        // $EXTMIN
        bs.BD3(this._minX, this._minY, 0);
        // $EXTMAX
        bs.BD3(this._maxX, this._maxY, 0);
        // $LIMMIN
        bs.BD2(this._minX, this._minY);
        // $LIMMAX
        bs.BD2(this._maxX, this._maxY);
        // $ORTHOMODE
        bs.BS(0);
        // $REGENMODE
        bs.BS(1);
        // $FILLMODE
        bs.BS(1);
        // $QTEXTMODE
        bs.BS(0);
        // $MIRRTEXT
        bs.BS(0);
        // $LTSCALE
        bs.BD(1.0);
        // $ATTMODE
        bs.BS(1);
        // $TEXTSIZE
        bs.BD(2.5);
        // $TRACEWID
        bs.BD(1.0);
        // $TEXTSTYLE handle
        bs.H(5, 3);
        // $CLAYER handle
        bs.H(5, 2);
        // $CELTYPE handle
        bs.H(5, 0);
        // $CECOLOR
        bs.BS(256);
        // $CELTSCALE
        bs.BD(1.0);
        // $DISPSILH
        bs.BS(0);
        // $DIMSCALE
        bs.BD(1.0);
        // $DIMASZ
        bs.BD(2.5);
        // $DIMEXO
        bs.BD(0.625);
        // $DIMDLI
        bs.BD(3.75);
        // $DIMRND
        bs.BD(0.0);
        // $DIMDLE
        bs.BD(0.0);
        // $DIMEXE
        bs.BD(1.25);
        // $DIMTP
        bs.BD(0.0);
        // $DIMTM
        bs.BD(0.0);
        // $DIMTXT
        bs.BD(2.5);
        // $DIMCEN
        bs.BD(2.5);
        // $DIMTSZ
        bs.BD(0.0);
        // $DIMTOL
        bs.B(false);
        // $DIMLIM
        bs.B(false);
        // $DIMTIH
        bs.B(true);
        // $DIMTOH
        bs.B(true);
        // $DIMSE1
        bs.B(false);
        // $DIMSE2
        bs.B(false);
        // $DIMTAD
        bs.BS(0);
        // $DIMZIN
        bs.BS(0);
        // $DIMAZIN
        bs.BS(0);
        // $DIMALT
        bs.B(false);
        // $DIMALTD
        bs.BS(2);
        // $DIMALTF
        bs.BD(25.4);
        // $DIMLFAC
        bs.BD(1.0);
        // $DIMTOFL
        bs.B(false);
        // $DIMTVP
        bs.BD(0.0);
        // $DIMTIX
        bs.B(false);
        // $DIMSOXD
        bs.B(false);
        // $DIMSAH
        bs.B(false);
        // $DIMBLK handle
        bs.H(5, 0);
        // $DIMBLK1 handle
        bs.H(5, 0);
        // $DIMBLK2 handle
        bs.H(5, 0);
        // $DIMSTYLE handle
        bs.H(5, 0);
        // $DIMCLRD
        bs.BS(0);
        // $DIMCLRE
        bs.BS(0);
        // $DIMCLRT
        bs.BS(0);
        // $DIMTFAC
        bs.BD(1.0);
        // $DIMGAP
        bs.BD(0.625);
        // $DIMJUST
        bs.BS(0);
        // $DIMSD1
        bs.B(false);
        // $DIMSD2
        bs.B(false);
        // $DIMTOLJ
        bs.BS(1);
        // $DIMTZIN
        bs.BS(0);
        // $DIMALTZ
        bs.BS(0);
        // $DIMALTTZ
        bs.BS(0);
        // $DIMUPT
        bs.B(false);
        // $DIMDEC
        bs.BS(4);
        // $DIMTDEC
        bs.BS(4);
        // $DIMALTU
        bs.BS(2);
        // $DIMALTTD
        bs.BS(2);
        // $DIMTXSTY handle
        bs.H(5, 0);
        // $DIMAUNIT
        bs.BS(0);
        // $DIMADEC
        bs.BS(0);
        // $DIMALTRND
        bs.BD(0.0);
        // $DIMAZIN
        bs.BS(0);
        // $DIMFIT
        bs.BS(3);
        // $DIMATFIT
        bs.BS(3);
        // $DIMLUNIT
        bs.BS(2);
        // $DIMFRAC
        bs.BS(0);
        // $DIMLDRBLK handle
        bs.H(5, 0);
        // $DIMLWD
        bs.BS(-2);
        // $DIMLWE
        bs.BS(-2);
        // $INSUNITS = 4 (mm)
        bs.BS(4);
        // CRC placeholder
        bs.RS(0);

        return this._wrapSection(0, bs.toBytes());
    }

    // ── Section 1: CLASSES (empty) ────────────────────────────────────────────
    _buildClassesSection() {
        const bs = new BitStream();
        bs.BL(0);   // 0 custom classes
        bs.RS(0);   // CRC placeholder
        return this._wrapSection(1, bs.toBytes());
    }

    // ── Section 2: OBJECTS (entities) ────────────────────────────────────────
    _buildObjectsSection() {
        const layerArr = [...this.layers.values()];
        const bs = new BitStream();

        for (const e of this.entities) {
            // Encode entity to its own buffer so we can prefix its size
            const entBs = new BitStream();
            switch (e.type) {
                case 'LINE':       this._encLine(entBs, e, layerArr);       break;
                case 'CIRCLE':     this._encCircle(entBs, e, layerArr);     break;
                case 'ARC':        this._encArc(entBs, e, layerArr);        break;
                case 'LWPOLYLINE': this._encLWPolyline(entBs, e, layerArr); break;
                case 'TEXT':       this._encText(entBs, e, layerArr);       break;
                default: continue;
            }
            const entData = entBs.toBytes();
            // Object size in bits (MS field)
            const bitLen = entData.length * 8;
            bs.MS(bitLen);
            bs.flush();
            // Append raw entity bytes
            for (let i = 0; i < entData.length; i++) bs.RC(entData[i]);
        }

        bs.RS(0); // CRC placeholder
        return this._wrapSection(2, bs.toBytes());
    }

    // Common entity header fields (written into an entity BitStream)
    _encCommon(bs, e, layerArr) {
        // Entity handle
        bs.H(3, e.handle);
        // Reactors count
        bs.BL(0);
        // XDictionary missing flag
        bs.B(true);
        // No links flag (R2000: true = newer format without prev/next links)
        bs.B(true);
        // Color = 256 (BYLAYER)
        bs.BS(256);
        // Linetype scale
        bs.BD(1.0);
        // Line type (BB): 00 = BYLAYER
        bs.BB(0);
        // Plot style (BB)
        bs.BB(0);
        // Visibility = 0
        bs.BS(0);
        // Num reactors (BL)
        bs.BL(0);
        // Layer handle
        const lay = layerArr.find(l => l.name === e.layer) || layerArr[0];
        bs.H(5, lay.handle);
        // Ltype handle (0 = none = BYLAYER)
        bs.H(5, 0);
    }

    _encLine(bs, e, layerArr) {
        bs.BS(19); // type: LINE
        this._encCommon(bs, e, layerArr);
        bs.B(true);  // Z-is-zero flag (true = 2D, no Z written)
        bs.B(true);  // Z-is-zero flag for end point
        bs.BD2(e.x1, e.y1);
        bs.BD2(e.x2, e.y2);
        bs.BD(0.0);  // thickness
        bs.B(true);  // extrusion = default (0,0,1), not written
    }

    _encCircle(bs, e, layerArr) {
        bs.BS(18); // type: CIRCLE
        this._encCommon(bs, e, layerArr);
        bs.BD3(e.cx, e.cy, 0);
        bs.BD(e.radius);
        bs.BD(0.0); // thickness
        bs.B(true); // extrusion default
    }

    _encArc(bs, e, layerArr) {
        bs.BS(17); // type: ARC
        this._encCommon(bs, e, layerArr);
        bs.BD3(e.cx, e.cy, 0);
        bs.BD(e.radius);
        bs.BD(0.0); // thickness
        bs.B(true); // extrusion default
        const DEG = Math.PI / 180;
        bs.BD(e.startAngle * DEG);
        bs.BD(e.endAngle   * DEG);
    }

    _encLWPolyline(bs, e, layerArr) {
        bs.BS(77); // type: LWPOLYLINE
        this._encCommon(bs, e, layerArr);
        bs.BL(e.closed ? 1 : 0); // flags: bit 0 = closed
        bs.BD(0.0);               // const width
        bs.BD(0.0);               // elevation
        bs.BD(0.0);               // thickness
        bs.B(true);               // extrusion default
        bs.BL(e.points.length);   // vertex count
        bs.BL(0);                 // bulge count
        bs.BL(0);                 // width count
        for (const pt of e.points) {
            bs.RD(pt[0]);
            bs.RD(pt[1]);
        }
    }

    _encText(bs, e, layerArr) {
        bs.BS(1); // type: TEXT
        this._encCommon(bs, e, layerArr);
        // DataFlags (RC):
        //   0x01 = elevation absent, 0x02 = alignment pt absent,
        //   0x04 = oblique absent,   0x08 = rotation absent,
        //   0x10 = width factor absent, 0x20 = generation absent,
        //   0x40 = horiz-align absent,  0x80 = vert-align absent
        bs.RC(0b11100100); // oblique/width/gen/horiz/vert all absent; rotation present
        // Insertion point (always present)
        bs.RD(e.x);
        bs.RD(e.y);
        // Height
        bs.BD(e.height || 2.5);
        // Text value
        bs.TV(e.text || '');
        // Rotation angle (in radians)
        bs.BD((e.rotation || 0) * Math.PI / 180);
        // Style handle (0 = Standard)
        bs.H(5, 0);
    }

    // ── Section 4: OBJECT MAP ─────────────────────────────────────────────────
    _buildObjectMapSection() {
        const bs = new BitStream();
        // One section of (handle, offset) pairs then a 0 section-size terminator
        // We use approximate offsets (0) since no actual seek tracking was done
        const blockBs = new BitStream();
        let lastHandle = 0;
        for (const e of this.entities) {
            const dHandle = e.handle - lastHandle;
            blockBs.MC(dHandle);
            blockBs.MC(0); // offset delta (approximate)
            lastHandle = e.handle;
        }
        blockBs.MC(0); // end of map entries
        const blockData = blockBs.toBytes();

        // Section count as RS, then size as RS, then data, then CRC
        bs.RS(1);                       // 1 block
        bs.RS(blockData.length + 2);    // block size (data + CRC RS)
        for (const b of blockData) bs.RC(b);
        bs.RS(0); // CRC placeholder

        return this._wrapSection(4, bs.toBytes());
    }

    // ── Download ──────────────────────────────────────────────────────────────
    download(filename) {
        filename = filename || 'output.dwg';
        const bytes = this.generate();
        const blob  = new Blob([bytes], { type: 'application/acad' });
        const url   = URL.createObjectURL(blob);
        const a     = document.createElement('a');
        a.href      = url;
        a.download  = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}
