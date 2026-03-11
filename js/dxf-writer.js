/**
 * DXF Writer - Generates AutoCAD DXF R2010 files from detected geometry.
 * Supports: LINE, LWPOLYLINE, CIRCLE, ARC, TEXT, MTEXT, DIMENSION entities.
 * Organizes output into layers: Walls, Furniture, Boundaries, Text, Dimensions.
 */
class DXFWriter {
    constructor() {
        this.entities = [];
        this.layers = new Map();
        this.handleCounter = 20;
        this.defaultTextHeight = 2.5;

        // Pre-allocate well-known handles
        this.modelSpaceBlockRecordHandle = this._nextHandle(); // 14
        this.paperSpaceBlockRecordHandle = this._nextHandle(); // 15
        this.modelSpaceBlockHandle = this._nextHandle();       // 16
        this.paperSpaceBlockHandle = this._nextHandle();       // 17

        // Define standard layers with AutoCAD color indices
        this.addLayer('0', 7);              // Default - white
        this.addLayer('Walls', 1);          // Red
        this.addLayer('Boundaries', 3);     // Green
        this.addLayer('Furniture', 5);      // Blue
        this.addLayer('Text', 4);           // Cyan
        this.addLayer('Dimensions', 6);     // Magenta
        this.addLayer('Detected_Lines', 1); // Red
        this.addLayer('Detected_Contours', 3); // Green
        this.addLayer('Detected_Text', 4);  // Cyan
    }

    _nextHandle() {
        return (this.handleCounter++).toString(16).toUpperCase();
    }

    addLayer(name, colorIndex = 7, lineType = 'CONTINUOUS') {
        this.layers.set(name, { name, colorIndex, lineType });
    }

    /**
     * Add a line entity
     */
    addLine(x1, y1, x2, y2, layer = '0') {
        this.entities.push({
            type: 'LINE',
            layer,
            x1, y1, x2, y2
        });
    }

    /**
     * Add a polyline (list of [x, y] points), optionally closed
     */
    addPolyline(points, layer = '0', closed = false) {
        if (points.length < 2) return;
        this.entities.push({
            type: 'LWPOLYLINE',
            layer,
            points,
            closed
        });
    }

    /**
     * Add a circle
     */
    addCircle(cx, cy, radius, layer = '0') {
        this.entities.push({
            type: 'CIRCLE',
            layer,
            cx, cy, radius
        });
    }

    /**
     * Add an arc
     */
    addArc(cx, cy, radius, startAngle, endAngle, layer = '0') {
        this.entities.push({
            type: 'ARC',
            layer,
            cx, cy, radius, startAngle, endAngle
        });
    }

    /**
     * Add a single-line text entity (converted to ARIAL)
     */
    addText(text, x, y, height = null, rotation = 0, layer = '0') {
        this.entities.push({
            type: 'TEXT',
            layer,
            text,
            x, y,
            height: height || this.defaultTextHeight,
            rotation
        });
    }

    /**
     * Add multiline text (MTEXT)
     */
    addMText(text, x, y, width = 100, height = null, layer = '0') {
        this.entities.push({
            type: 'MTEXT',
            layer,
            text,
            x, y,
            width,
            height: height || this.defaultTextHeight
        });
    }

    /**
     * Add a rectangle (as closed polyline)
     */
    addRectangle(x, y, w, h, layer = '0') {
        this.addPolyline([
            [x, y], [x + w, y], [x + w, y + h], [x, y + h]
        ], layer, true);
    }

    // ── DXF Generation ──────────────────────────────────────────────

    generate() {
        this._computeBounds();
        let dxf = '';
        dxf += this._headerSection();
        dxf += this._classesSection();
        dxf += this._tablesSection();
        dxf += this._blocksSection();
        dxf += this._entitiesSection();
        dxf += this._objectsSection();
        dxf += '  0\nEOF\n';
        return dxf;
    }

    _computeBounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const expand = (x, y) => {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        };
        for (const e of this.entities) {
            switch (e.type) {
                case 'LINE':
                    expand(e.x1, e.y1); expand(e.x2, e.y2); break;
                case 'LWPOLYLINE':
                    for (const [x, y] of e.points) expand(x, y); break;
                case 'CIRCLE': case 'ARC':
                    expand(e.cx - e.radius, e.cy - e.radius);
                    expand(e.cx + e.radius, e.cy + e.radius); break;
                case 'TEXT': case 'MTEXT':
                    expand(e.x, e.y); break;
            }
        }
        if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1000; maxY = 1000; }
        const padX = Math.max((maxX - minX) * 0.05, 10);
        const padY = Math.max((maxY - minY) * 0.05, 10);
        this.boundsMinX = minX - padX;
        this.boundsMinY = minY - padY;
        this.boundsMaxX = maxX + padX;
        this.boundsMaxY = maxY + padY;
        this.viewCenterX = (minX + maxX) / 2;
        this.viewCenterY = (minY + maxY) / 2;
        this.viewHeight  = Math.max((maxY - minY) * 1.2, 100);
    }

    _pair(code, value) {
        return `${code.toString().padStart(3)}\n${value}\n`;
    }

    _classesSection() {
        // Required empty CLASSES section for DXF R2004+ (AC1018+) compatibility.
        // AutoCAD R2010 expects this section even when no custom classes are defined.
        let s = '';
        s += this._pair(0, 'SECTION');
        s += this._pair(2, 'CLASSES');
        s += this._pair(0, 'ENDSEC');
        return s;
    }

    _headerSection() {
        let s = '';
        s += this._pair(0, 'SECTION');
        s += this._pair(2, 'HEADER');

        // AutoCAD version
        s += this._pair(9, '$ACADVER');
        s += this._pair(1, 'AC1024'); // R2010

        // Insertion base point
        s += this._pair(9, '$INSBASE');
        s += this._pair(10, '0.0');
        s += this._pair(20, '0.0');
        s += this._pair(30, '0.0');

        // Drawing extents (computed from actual entities)
        s += this._pair(9, '$EXTMIN');
        s += this._pair(10, this.boundsMinX.toFixed(6));
        s += this._pair(20, this.boundsMinY.toFixed(6));
        s += this._pair(30, '0.0');

        s += this._pair(9, '$EXTMAX');
        s += this._pair(10, this.boundsMaxX.toFixed(6));
        s += this._pair(20, this.boundsMaxY.toFixed(6));
        s += this._pair(30, '0.0');

        // Text style
        s += this._pair(9, '$TEXTSTYLE');
        s += this._pair(7, 'ARIAL');

        s += this._pair(0, 'ENDSEC');
        return s;
    }

    _tablesSection() {
        let s = '';
        s += this._pair(0, 'SECTION');
        s += this._pair(2, 'TABLES');

        // ── VPORT table ──
        const vportTableHandle = this._nextHandle();
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'VPORT');
        s += this._pair(5, vportTableHandle);
        s += this._pair(330, '0');
        s += this._pair(100, 'AcDbSymbolTable');
        s += this._pair(70, 1);

        // *Active viewport — required so CAD viewers know where to look
        s += this._pair(0, 'VPORT');
        s += this._pair(5, this._nextHandle());
        s += this._pair(330, vportTableHandle);
        s += this._pair(100, 'AcDbSymbolTableRecord');
        s += this._pair(100, 'AcDbViewportTableRecord');
        s += this._pair(2, '*Active');
        s += this._pair(70, 0);
        s += this._pair(10, '0.0');   // lower-left corner (normalized)
        s += this._pair(20, '0.0');
        s += this._pair(11, '1.0');   // upper-right corner (normalized)
        s += this._pair(21, '1.0');
        s += this._pair(12, this.viewCenterX.toFixed(6));  // view center X
        s += this._pair(22, this.viewCenterY.toFixed(6));  // view center Y
        s += this._pair(13, '0.0');
        s += this._pair(23, '0.0');
        s += this._pair(14, '10.0');
        s += this._pair(24, '10.0');
        s += this._pair(15, '10.0');
        s += this._pair(25, '10.0');
        s += this._pair(16, '0.0');   // view direction (plan view)
        s += this._pair(26, '0.0');
        s += this._pair(36, '1.0');
        s += this._pair(17, '0.0');   // view target
        s += this._pair(27, '0.0');
        s += this._pair(37, '0.0');
        s += this._pair(40, this.viewHeight.toFixed(6));   // view height
        s += this._pair(41, '1.0');   // aspect ratio
        s += this._pair(42, '50.0');  // lens length
        s += this._pair(43, '0.0');
        s += this._pair(44, '0.0');
        s += this._pair(50, '0.0');
        s += this._pair(51, '0.0');
        s += this._pair(71, 0);
        s += this._pair(72, 1000);
        s += this._pair(73, 1);
        s += this._pair(74, 3);
        s += this._pair(75, 0);
        s += this._pair(76, 0);
        s += this._pair(77, 0);
        s += this._pair(78, 0);
        s += this._pair(0, 'ENDTAB');

        // ── LTYPE table ──
        const ltypeTableHandle = this._nextHandle();
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'LTYPE');
        s += this._pair(5, ltypeTableHandle);
        s += this._pair(330, '0');
        s += this._pair(100, 'AcDbSymbolTable');
        s += this._pair(70, 1);

        s += this._pair(0, 'LTYPE');
        s += this._pair(5, this._nextHandle());
        s += this._pair(330, ltypeTableHandle);
        s += this._pair(100, 'AcDbSymbolTableRecord');
        s += this._pair(100, 'AcDbLinetypeTableRecord');
        s += this._pair(2, 'CONTINUOUS');
        s += this._pair(70, 0);
        s += this._pair(3, 'Solid line');
        s += this._pair(72, 65);
        s += this._pair(73, 0);
        s += this._pair(40, '0.0');
        s += this._pair(0, 'ENDTAB');

        // ── LAYER table ──
        const layerTableHandle = this._nextHandle();
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'LAYER');
        s += this._pair(5, layerTableHandle);
        s += this._pair(330, '0');
        s += this._pair(100, 'AcDbSymbolTable');
        s += this._pair(70, this.layers.size);

        for (const [name, layer] of this.layers) {
            s += this._pair(0, 'LAYER');
            s += this._pair(5, this._nextHandle());
            s += this._pair(330, layerTableHandle);
            s += this._pair(100, 'AcDbSymbolTableRecord');
            s += this._pair(100, 'AcDbLayerTableRecord');
            s += this._pair(2, name);
            s += this._pair(70, 0);
            s += this._pair(62, layer.colorIndex);
            s += this._pair(6, layer.lineType);
        }
        s += this._pair(0, 'ENDTAB');

        // ── STYLE table ──
        const styleTableHandle = this._nextHandle();
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'STYLE');
        s += this._pair(5, styleTableHandle);
        s += this._pair(330, '0');
        s += this._pair(100, 'AcDbSymbolTable');
        s += this._pair(70, 1);

        s += this._pair(0, 'STYLE');
        s += this._pair(5, this._nextHandle());
        s += this._pair(330, styleTableHandle);
        s += this._pair(100, 'AcDbSymbolTableRecord');
        s += this._pair(100, 'AcDbTextStyleTableRecord');
        s += this._pair(2, 'ARIAL');
        s += this._pair(70, 0);
        s += this._pair(40, '0.0');
        s += this._pair(41, '1.0');
        s += this._pair(50, '0.0');
        s += this._pair(71, 0);
        s += this._pair(42, '2.5');
        s += this._pair(3, 'arial.ttf');
        s += this._pair(4, '');
        s += this._pair(0, 'ENDTAB');

        // ── APPID table ──
        const appidTableHandle = this._nextHandle();
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'APPID');
        s += this._pair(5, appidTableHandle);
        s += this._pair(330, '0');
        s += this._pair(100, 'AcDbSymbolTable');
        s += this._pair(70, 1);

        s += this._pair(0, 'APPID');
        s += this._pair(5, this._nextHandle());
        s += this._pair(330, appidTableHandle);
        s += this._pair(100, 'AcDbSymbolTableRecord');
        s += this._pair(100, 'AcDbRegAppTableRecord');
        s += this._pair(2, 'ACAD');
        s += this._pair(70, 0);
        s += this._pair(0, 'ENDTAB');

        // ── BLOCK_RECORD table ──
        const blockRecordTableHandle = this._nextHandle();
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'BLOCK_RECORD');
        s += this._pair(5, blockRecordTableHandle);
        s += this._pair(330, '0');
        s += this._pair(100, 'AcDbSymbolTable');
        s += this._pair(70, 2);

        s += this._pair(0, 'BLOCK_RECORD');
        s += this._pair(5, this.modelSpaceBlockRecordHandle);
        s += this._pair(330, blockRecordTableHandle);
        s += this._pair(100, 'AcDbSymbolTableRecord');
        s += this._pair(100, 'AcDbBlockTableRecord');
        s += this._pair(2, '*Model_Space');

        s += this._pair(0, 'BLOCK_RECORD');
        s += this._pair(5, this.paperSpaceBlockRecordHandle);
        s += this._pair(330, blockRecordTableHandle);
        s += this._pair(100, 'AcDbSymbolTableRecord');
        s += this._pair(100, 'AcDbBlockTableRecord');
        s += this._pair(2, '*Paper_Space');

        s += this._pair(0, 'ENDTAB');

        s += this._pair(0, 'ENDSEC');
        return s;
    }

    _blocksSection() {
        let s = '';
        s += this._pair(0, 'SECTION');
        s += this._pair(2, 'BLOCKS');

        // *Model_Space block definition
        s += this._pair(0, 'BLOCK');
        s += this._pair(5, this.modelSpaceBlockHandle);
        s += this._pair(330, this.modelSpaceBlockRecordHandle);
        s += this._pair(100, 'AcDbEntity');
        s += this._pair(8, '0');
        s += this._pair(100, 'AcDbBlockBegin');
        s += this._pair(2, '*Model_Space');
        s += this._pair(70, 0);
        s += this._pair(10, '0.0');
        s += this._pair(20, '0.0');
        s += this._pair(30, '0.0');
        s += this._pair(3, '*Model_Space');
        s += this._pair(1, '');
        s += this._pair(0, 'ENDBLK');
        s += this._pair(5, this._nextHandle());
        s += this._pair(330, this.modelSpaceBlockRecordHandle);
        s += this._pair(100, 'AcDbEntity');
        s += this._pair(8, '0');
        s += this._pair(100, 'AcDbBlockEnd');

        // *Paper_Space block definition
        s += this._pair(0, 'BLOCK');
        s += this._pair(5, this.paperSpaceBlockHandle);
        s += this._pair(330, this.paperSpaceBlockRecordHandle);
        s += this._pair(100, 'AcDbEntity');
        s += this._pair(8, '0');
        s += this._pair(100, 'AcDbBlockBegin');
        s += this._pair(2, '*Paper_Space');
        s += this._pair(70, 0);
        s += this._pair(10, '0.0');
        s += this._pair(20, '0.0');
        s += this._pair(30, '0.0');
        s += this._pair(3, '*Paper_Space');
        s += this._pair(1, '');
        s += this._pair(0, 'ENDBLK');
        s += this._pair(5, this._nextHandle());
        s += this._pair(330, this.paperSpaceBlockRecordHandle);
        s += this._pair(100, 'AcDbEntity');
        s += this._pair(8, '0');
        s += this._pair(100, 'AcDbBlockEnd');

        s += this._pair(0, 'ENDSEC');
        return s;
    }

    _entitiesSection() {
        let s = '';
        s += this._pair(0, 'SECTION');
        s += this._pair(2, 'ENTITIES');

        for (const entity of this.entities) {
            s += this._writeEntity(entity);
        }

        s += this._pair(0, 'ENDSEC');
        return s;
    }

    _writeEntity(e) {
        let s = '';
        switch (e.type) {
            case 'LINE':
                s += this._pair(0, 'LINE');
                s += this._pair(5, this._nextHandle());
                s += this._pair(330, this.modelSpaceBlockRecordHandle);
                s += this._pair(100, 'AcDbEntity');
                s += this._pair(8, e.layer);
                s += this._pair(100, 'AcDbLine');
                s += this._pair(10, e.x1.toFixed(6));
                s += this._pair(20, e.y1.toFixed(6));
                s += this._pair(30, '0.0');
                s += this._pair(11, e.x2.toFixed(6));
                s += this._pair(21, e.y2.toFixed(6));
                s += this._pair(31, '0.0');
                break;

            case 'LWPOLYLINE':
                s += this._pair(0, 'LWPOLYLINE');
                s += this._pair(5, this._nextHandle());
                s += this._pair(330, this.modelSpaceBlockRecordHandle);
                s += this._pair(100, 'AcDbEntity');
                s += this._pair(8, e.layer);
                s += this._pair(100, 'AcDbPolyline');
                s += this._pair(90, e.points.length);
                s += this._pair(70, e.closed ? 1 : 0);
                for (const [x, y] of e.points) {
                    s += this._pair(10, x.toFixed(6));
                    s += this._pair(20, y.toFixed(6));
                }
                break;

            case 'CIRCLE':
                s += this._pair(0, 'CIRCLE');
                s += this._pair(5, this._nextHandle());
                s += this._pair(330, this.modelSpaceBlockRecordHandle);
                s += this._pair(100, 'AcDbEntity');
                s += this._pair(8, e.layer);
                s += this._pair(100, 'AcDbCircle');
                s += this._pair(10, e.cx.toFixed(6));
                s += this._pair(20, e.cy.toFixed(6));
                s += this._pair(30, '0.0');
                s += this._pair(40, e.radius.toFixed(6));
                break;

            case 'ARC':
                s += this._pair(0, 'ARC');
                s += this._pair(5, this._nextHandle());
                s += this._pair(330, this.modelSpaceBlockRecordHandle);
                s += this._pair(100, 'AcDbEntity');
                s += this._pair(8, e.layer);
                s += this._pair(100, 'AcDbCircle');
                s += this._pair(10, e.cx.toFixed(6));
                s += this._pair(20, e.cy.toFixed(6));
                s += this._pair(30, '0.0');
                s += this._pair(40, e.radius.toFixed(6));
                s += this._pair(100, 'AcDbArc');
                s += this._pair(50, e.startAngle.toFixed(6));
                s += this._pair(51, e.endAngle.toFixed(6));
                break;

            case 'TEXT':
                s += this._pair(0, 'TEXT');
                s += this._pair(5, this._nextHandle());
                s += this._pair(330, this.modelSpaceBlockRecordHandle);
                s += this._pair(100, 'AcDbEntity');
                s += this._pair(8, e.layer);
                s += this._pair(100, 'AcDbText');
                s += this._pair(7, 'ARIAL');
                s += this._pair(10, e.x.toFixed(6));
                s += this._pair(20, e.y.toFixed(6));
                s += this._pair(30, '0.0');
                s += this._pair(40, e.height.toFixed(6));
                s += this._pair(50, e.rotation.toFixed(6));
                s += this._pair(1, e.text);
                s += this._pair(100, 'AcDbText');
                break;

            case 'MTEXT':
                s += this._pair(0, 'MTEXT');
                s += this._pair(5, this._nextHandle());
                s += this._pair(330, this.modelSpaceBlockRecordHandle);
                s += this._pair(100, 'AcDbEntity');
                s += this._pair(8, e.layer);
                s += this._pair(100, 'AcDbMText');
                s += this._pair(7, 'ARIAL');
                s += this._pair(10, e.x.toFixed(6));
                s += this._pair(20, e.y.toFixed(6));
                s += this._pair(30, '0.0');
                s += this._pair(40, e.height.toFixed(6));
                s += this._pair(41, e.width.toFixed(6));
                s += this._pair(1, e.text);
                break;
        }
        return s;
    }

    _objectsSection() {
        let s = '';
        s += this._pair(0, 'SECTION');
        s += this._pair(2, 'OBJECTS');

        // Root dictionary
        s += this._pair(0, 'DICTIONARY');
        s += this._pair(5, this._nextHandle());
        s += this._pair(330, '0');
        s += this._pair(100, 'AcDbDictionary');
        s += this._pair(281, 1);

        s += this._pair(0, 'ENDSEC');
        return s;
    }

    /**
     * Generate and trigger a browser download
     */
    download(filename = 'output.dxf') {
        const content = this.generate();
        const blob = new Blob([content], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Get entity statistics
     */
    getStats() {
        const stats = { total: this.entities.length };
        for (const e of this.entities) {
            stats[e.type] = (stats[e.type] || 0) + 1;
        }
        return stats;
    }
}
