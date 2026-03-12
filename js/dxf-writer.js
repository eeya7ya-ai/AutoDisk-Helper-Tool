/**
 * DXF Writer - Generates AutoCAD DXF R2018 (AC1032) files from detected geometry.
 * Supports: LINE, LWPOLYLINE, CIRCLE, ARC, TEXT, MTEXT entities.
 * Organizes output into layers: Walls, Furniture, Boundaries, Text, Dimensions.
 *
 * Compatible with: AutoCAD 2018+, Revit 2019+, newer CAD viewers.
 * Key fixes vs AC1024 export:
 *   - Version AC1032 (R2018) for newer Revit/AutoCAD compatibility
 *   - $INSUNITS=4 (mm) so Revit scales the import correctly
 *   - LAYOUT objects in OBJECTS section (required by Revit 2019+)
 *   - DIMSTYLE table (required by R2018 strict parsers)
 *   - Correct VPORT aspect ratio computed from drawing bounds
 *   - Space flag (67) on BLOCK definitions
 */
class DXFWriter {
    constructor() {
        this.entities = [];
        this.layers = new Map();
        this.handleCounter = 20;
        this.defaultTextHeight = 2.5;

        // Pre-allocate well-known handles so cross-references work
        this.modelSpaceBlockRecordHandle = this._nextHandle(); // 14
        this.paperSpaceBlockRecordHandle = this._nextHandle(); // 15
        this.modelSpaceBlockHandle       = this._nextHandle(); // 16
        this.paperSpaceBlockHandle       = this._nextHandle(); // 17
        this.arialStyleHandle            = this._nextHandle(); // 18 – needed by DIMSTYLE
        this.namedObjsDictHandle         = this._nextHandle(); // 19
        this.groupDictHandle             = this._nextHandle(); // 1A
        this.layoutDictHandle            = this._nextHandle(); // 1B
        this.mlineStyleDictHandle        = this._nextHandle(); // 1C
        this.modelLayoutHandle           = this._nextHandle(); // 1D
        this.layout1Handle               = this._nextHandle(); // 1E
        this.plotStyleNameDictHandle     = this._nextHandle(); // 1F
        this.normalPlotStyleHandle       = this._nextHandle(); // 20

        // Define standard layers with AutoCAD color indices
        this.addLayer('0', 7);                 // Default - white
        this.addLayer('Walls', 1);             // Red
        this.addLayer('Boundaries', 3);        // Green
        this.addLayer('Furniture', 5);         // Blue
        this.addLayer('Text', 4);              // Cyan
        this.addLayer('Dimensions', 6);        // Magenta
        this.addLayer('Detected_Lines', 1);    // Red
        this.addLayer('Detected_Contours', 3); // Green
        this.addLayer('Detected_Text', 4);     // Cyan
    }

    _nextHandle() {
        return (this.handleCounter++).toString(16).toUpperCase();
    }

    addLayer(name, colorIndex = 7, lineType = 'CONTINUOUS') {
        this.layers.set(name, { name, colorIndex, lineType });
    }

    // ── Entity Helpers ───────────────────────────────────────────────

    addLine(x1, y1, x2, y2, layer = '0') {
        this.entities.push({ type: 'LINE', layer, x1, y1, x2, y2 });
    }

    addPolyline(points, layer = '0', closed = false) {
        if (points.length < 2) return;
        this.entities.push({ type: 'LWPOLYLINE', layer, points, closed });
    }

    addCircle(cx, cy, radius, layer = '0') {
        this.entities.push({ type: 'CIRCLE', layer, cx, cy, radius });
    }

    addArc(cx, cy, radius, startAngle, endAngle, layer = '0') {
        this.entities.push({ type: 'ARC', layer, cx, cy, radius, startAngle, endAngle });
    }

    addText(text, x, y, height = null, rotation = 0, layer = '0') {
        this.entities.push({
            type: 'TEXT', layer, text, x, y,
            height: height || this.defaultTextHeight, rotation
        });
    }

    addMText(text, x, y, width = 100, height = null, layer = '0') {
        this.entities.push({
            type: 'MTEXT', layer, text, x, y,
            width, height: height || this.defaultTextHeight
        });
    }

    addRectangle(x, y, w, h, layer = '0') {
        this.addPolyline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], layer, true);
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

        // Compute view height and aspect ratio from actual drawing dimensions
        const drawW = (maxX - minX) || 1000;
        const drawH = (maxY - minY) || 1000;
        this.viewHeight = Math.max(drawH * 1.2, 100);
        this.viewWidth  = Math.max(drawW * 1.2, 150);
        this.viewAspect = this.viewWidth / this.viewHeight;
    }

    _pair(code, value) {
        return `${code.toString().padStart(3)}\n${value}\n`;
    }

    // ── CLASSES (required for R2004+) ───────────────────────────────

    _classesSection() {
        let s = '';
        s += this._pair(0, 'SECTION');
        s += this._pair(2, 'CLASSES');
        s += this._pair(0, 'ENDSEC');
        return s;
    }

    // ── HEADER ──────────────────────────────────────────────────────

    _headerSection() {
        let s = '';
        s += this._pair(0, 'SECTION');
        s += this._pair(2, 'HEADER');

        // ── Version ──────────────────────────────────────────────────
        // AC1032 = AutoCAD 2018 / R2018 – required for Revit 2019+ compatibility
        s += this._pair(9, '$ACADVER');
        s += this._pair(1, 'AC1032');

        // ── Geometry extents ─────────────────────────────────────────
        s += this._pair(9, '$INSBASE');
        s += this._pair(10, '0.0');
        s += this._pair(20, '0.0');
        s += this._pair(30, '0.0');

        s += this._pair(9, '$EXTMIN');
        s += this._pair(10, this.boundsMinX.toFixed(6));
        s += this._pair(20, this.boundsMinY.toFixed(6));
        s += this._pair(30, '0.0');

        s += this._pair(9, '$EXTMAX');
        s += this._pair(10, this.boundsMaxX.toFixed(6));
        s += this._pair(20, this.boundsMaxY.toFixed(6));
        s += this._pair(30, '0.0');

        // Drawing limits matching the extents
        s += this._pair(9, '$LIMMIN');
        s += this._pair(10, this.boundsMinX.toFixed(6));
        s += this._pair(20, this.boundsMinY.toFixed(6));

        s += this._pair(9, '$LIMMAX');
        s += this._pair(10, this.boundsMaxX.toFixed(6));
        s += this._pair(20, this.boundsMaxY.toFixed(6));

        // ── Units – CRITICAL for Revit import scaling ─────────────────
        // $INSUNITS = 4 → millimeters.  Revit reads this to scale the DXF.
        // Without it Revit defaults to "unitless" and may scale everything wrong.
        s += this._pair(9, '$INSUNITS');
        s += this._pair(70, 4);   // 4 = millimeters

        s += this._pair(9, '$MEASUREMENT');
        s += this._pair(70, 1);   // 1 = metric

        s += this._pair(9, '$LUNITS');
        s += this._pair(70, 2);   // 2 = decimal

        s += this._pair(9, '$LUPREC');
        s += this._pair(70, 4);   // 4 decimal places

        s += this._pair(9, '$AUNITS');
        s += this._pair(70, 0);   // 0 = decimal degrees

        s += this._pair(9, '$AUPREC');
        s += this._pair(70, 0);

        s += this._pair(9, '$ANGBASE');
        s += this._pair(50, '0.0');

        s += this._pair(9, '$ANGDIR');
        s += this._pair(70, 0);   // 0 = counterclockwise

        // ── Line type / lineweight ────────────────────────────────────
        s += this._pair(9, '$LTSCALE');
        s += this._pair(40, '1.0');

        s += this._pair(9, '$PSLTSCALE');
        s += this._pair(70, 1);

        s += this._pair(9, '$LWDISPLAY');
        s += this._pair(290, 0);

        // ── Current entity defaults ───────────────────────────────────
        s += this._pair(9, '$CLAYER');
        s += this._pair(8, '0');

        s += this._pair(9, '$CELTYPE');
        s += this._pair(6, 'CONTINUOUS');

        s += this._pair(9, '$CECOLOR');
        s += this._pair(62, 256);  // 256 = BYLAYER

        s += this._pair(9, '$CELTSCALE');
        s += this._pair(40, '1.0');

        // ── Text / dimension styles ───────────────────────────────────
        s += this._pair(9, '$TEXTSTYLE');
        s += this._pair(7, 'ARIAL');

        s += this._pair(9, '$TEXTSIZE');
        s += this._pair(40, '2.5');

        s += this._pair(9, '$DIMSTYLE');
        s += this._pair(2, 'Standard');

        // ── Object snap (irrelevant for import, prevents parse warnings) ─
        s += this._pair(9, '$OSMODE');
        s += this._pair(70, 0);

        s += this._pair(0, 'ENDSEC');
        return s;
    }

    // ── TABLES ──────────────────────────────────────────────────────

    _tablesSection() {
        let s = '';
        s += this._pair(0, 'SECTION');
        s += this._pair(2, 'TABLES');

        // ── VPORT ────────────────────────────────────────────────────
        const vportTableHandle = this._nextHandle();
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'VPORT');
        s += this._pair(5, vportTableHandle);
        s += this._pair(330, '0');
        s += this._pair(100, 'AcDbSymbolTable');
        s += this._pair(70, 1);

        // *Active viewport – without this CAD viewers open with blank screen
        s += this._pair(0, 'VPORT');
        s += this._pair(5, this._nextHandle());
        s += this._pair(330, vportTableHandle);
        s += this._pair(100, 'AcDbSymbolTableRecord');
        s += this._pair(100, 'AcDbViewportTableRecord');
        s += this._pair(2, '*Active');
        s += this._pair(70, 0);
        s += this._pair(10, '0.0');   // lower-left (normalized)
        s += this._pair(20, '0.0');
        s += this._pair(11, '1.0');   // upper-right (normalized)
        s += this._pair(21, '1.0');
        s += this._pair(12, this.viewCenterX.toFixed(6));  // view center X
        s += this._pair(22, this.viewCenterY.toFixed(6));  // view center Y
        s += this._pair(13, '0.0');
        s += this._pair(23, '0.0');
        s += this._pair(14, '10.0');
        s += this._pair(24, '10.0');
        s += this._pair(15, '10.0');
        s += this._pair(25, '10.0');
        s += this._pair(16, '0.0');   // view direction (plan/top view)
        s += this._pair(26, '0.0');
        s += this._pair(36, '1.0');
        s += this._pair(17, '0.0');   // view target
        s += this._pair(27, '0.0');
        s += this._pair(37, '0.0');
        s += this._pair(40, this.viewHeight.toFixed(6));   // view height
        // Aspect ratio from actual drawing bounds – fixes "shows nothing" when
        // drawing is wider or taller than square
        s += this._pair(41, this.viewAspect.toFixed(6));
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

        // ── LTYPE ────────────────────────────────────────────────────
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

        // ── LAYER ────────────────────────────────────────────────────
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
            s += this._pair(390, this.normalPlotStyleHandle); // PlotStyleName (required by AC1032+)
        }
        s += this._pair(0, 'ENDTAB');

        // ── STYLE ────────────────────────────────────────────────────
        const styleTableHandle = this._nextHandle();
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'STYLE');
        s += this._pair(5, styleTableHandle);
        s += this._pair(330, '0');
        s += this._pair(100, 'AcDbSymbolTable');
        s += this._pair(70, 1);

        // Use pre-allocated handle so DIMSTYLE can reference it
        s += this._pair(0, 'STYLE');
        s += this._pair(5, this.arialStyleHandle);
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

        // ── APPID ────────────────────────────────────────────────────
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

        // ── DIMSTYLE ─────────────────────────────────────────────────
        // Required by DXF R2018 strict parsers (Revit 2019+ checks for this table)
        const dimstyleTableHandle = this._nextHandle();
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'DIMSTYLE');
        s += this._pair(5, dimstyleTableHandle);
        s += this._pair(330, '0');
        s += this._pair(100, 'AcDbSymbolTable');
        s += this._pair(70, 1);
        s += this._pair(100, 'AcDbDimStyleTable');
        s += this._pair(71, 1);

        // Standard dimension style – note DIMSTYLE uses group code 105 for handle
        s += this._pair(0, 'DIMSTYLE');
        s += this._pair(105, this._nextHandle());
        s += this._pair(330, dimstyleTableHandle);
        s += this._pair(100, 'AcDbSymbolTableRecord');
        s += this._pair(100, 'AcDbDimStyleTableRecord');
        s += this._pair(2, 'Standard');
        s += this._pair(70, 0);
        s += this._pair(3, '');
        s += this._pair(4, '');
        s += this._pair(40, '0.0');
        s += this._pair(41, '2.5');
        s += this._pair(42, '0.625');
        s += this._pair(43, '3.75');
        s += this._pair(44, '1.25');
        s += this._pair(45, '0.0');
        s += this._pair(46, '0.0');
        s += this._pair(47, '0.0');
        s += this._pair(48, '0.0');
        s += this._pair(140, '2.5');
        s += this._pair(141, '2.5');
        s += this._pair(142, '0.0');
        s += this._pair(143, '25.4');
        s += this._pair(144, '1.0');
        s += this._pair(145, '0.0');
        s += this._pair(146, '1.0');
        s += this._pair(147, '0.625');
        s += this._pair(148, '0.0');
        s += this._pair(71, 0);
        s += this._pair(72, 0);
        s += this._pair(73, 1);
        s += this._pair(74, 1);
        s += this._pair(75, 0);
        s += this._pair(76, 0);
        s += this._pair(77, 0);
        s += this._pair(78, 0);
        s += this._pair(170, 0);
        s += this._pair(171, 2);
        s += this._pair(172, 0);
        s += this._pair(173, 0);
        s += this._pair(174, 0);
        s += this._pair(175, 0);
        s += this._pair(176, 0);
        s += this._pair(177, 0);
        s += this._pair(178, 0);
        s += this._pair(271, 2);
        s += this._pair(272, 2);
        s += this._pair(273, 2);
        s += this._pair(274, 3);
        s += this._pair(275, 0);
        s += this._pair(276, 0);
        s += this._pair(277, 2);
        s += this._pair(278, 44);
        s += this._pair(279, 0);
        s += this._pair(280, 0);
        s += this._pair(281, 0);
        s += this._pair(282, 0);
        s += this._pair(283, 0);
        s += this._pair(284, 8);
        s += this._pair(285, 0);
        s += this._pair(286, 0);
        s += this._pair(289, 3);
        s += this._pair(290, 0);
        s += this._pair(340, this.arialStyleHandle);  // text style reference
        s += this._pair(371, -2);
        s += this._pair(372, -2);
        s += this._pair(0, 'ENDTAB');

        // ── BLOCK_RECORD ─────────────────────────────────────────────
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
        s += this._pair(70, 0);

        s += this._pair(0, 'BLOCK_RECORD');
        s += this._pair(5, this.paperSpaceBlockRecordHandle);
        s += this._pair(330, blockRecordTableHandle);
        s += this._pair(100, 'AcDbSymbolTableRecord');
        s += this._pair(100, 'AcDbBlockTableRecord');
        s += this._pair(2, '*Paper_Space');
        s += this._pair(70, 0);

        s += this._pair(0, 'ENDTAB');

        s += this._pair(0, 'ENDSEC');
        return s;
    }

    // ── BLOCKS ──────────────────────────────────────────────────────

    _blocksSection() {
        let s = '';
        s += this._pair(0, 'SECTION');
        s += this._pair(2, 'BLOCKS');

        // *Model_Space block definition
        s += this._pair(0, 'BLOCK');
        s += this._pair(5, this.modelSpaceBlockHandle);
        s += this._pair(330, this.modelSpaceBlockRecordHandle);
        s += this._pair(100, 'AcDbEntity');
        s += this._pair(67, 0);   // 0 = model space flag
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
        s += this._pair(67, 0);
        s += this._pair(8, '0');
        s += this._pair(100, 'AcDbBlockEnd');

        // *Paper_Space block definition
        s += this._pair(0, 'BLOCK');
        s += this._pair(5, this.paperSpaceBlockHandle);
        s += this._pair(330, this.paperSpaceBlockRecordHandle);
        s += this._pair(100, 'AcDbEntity');
        s += this._pair(67, 1);   // 1 = paper space flag
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
        s += this._pair(67, 1);
        s += this._pair(8, '0');
        s += this._pair(100, 'AcDbBlockEnd');

        s += this._pair(0, 'ENDSEC');
        return s;
    }

    // ── ENTITIES ────────────────────────────────────────────────────

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
                s += this._pair(43, '0.0');   // constant width
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
                s += this._pair(71, 1);   // attachment point: top-left
                s += this._pair(72, 5);   // drawing direction: by style
                s += this._pair(1, e.text);
                break;
        }
        return s;
    }

    // ── OBJECTS ─────────────────────────────────────────────────────
    //
    // Revit 2019+ requires a properly structured OBJECTS section with:
    //   - A named-objects root DICTIONARY referencing ACAD_LAYOUT
    //   - An ACAD_LAYOUT DICTIONARY with "Model" and "Layout1" entries
    //   - LAYOUT objects for model space and paper space
    // Without these, newer Revit versions refuse to open / import the file.

    _objectsSection() {
        let s = '';
        s += this._pair(0, 'SECTION');
        s += this._pair(2, 'OBJECTS');

        // ── Root named-objects dictionary ────────────────────────────
        s += this._pair(0, 'DICTIONARY');
        s += this._pair(5, this.namedObjsDictHandle);
        s += this._pair(330, '0');
        s += this._pair(100, 'AcDbDictionary');
        s += this._pair(281, 1);
        s += this._pair(3, 'ACAD_GROUP');
        s += this._pair(350, this.groupDictHandle);
        s += this._pair(3, 'ACAD_LAYOUT');
        s += this._pair(350, this.layoutDictHandle);
        s += this._pair(3, 'ACAD_MLINESTYLE');
        s += this._pair(350, this.mlineStyleDictHandle);
        s += this._pair(3, 'ACAD_PLOTSTYLENAME');
        s += this._pair(350, this.plotStyleNameDictHandle);

        // ── ACAD_GROUP (empty) ───────────────────────────────────────
        s += this._pair(0, 'DICTIONARY');
        s += this._pair(5, this.groupDictHandle);
        s += this._pair(330, this.namedObjsDictHandle);
        s += this._pair(100, 'AcDbDictionary');
        s += this._pair(281, 1);

        // ── ACAD_LAYOUT dictionary ───────────────────────────────────
        s += this._pair(0, 'DICTIONARY');
        s += this._pair(5, this.layoutDictHandle);
        s += this._pair(330, this.namedObjsDictHandle);
        s += this._pair(100, 'AcDbDictionary');
        s += this._pair(281, 1);
        s += this._pair(3, 'Model');
        s += this._pair(350, this.modelLayoutHandle);
        s += this._pair(3, 'Layout1');
        s += this._pair(350, this.layout1Handle);

        // ── ACAD_MLINESTYLE (empty) ───────────────────────────────────
        s += this._pair(0, 'DICTIONARY');
        s += this._pair(5, this.mlineStyleDictHandle);
        s += this._pair(330, this.namedObjsDictHandle);
        s += this._pair(100, 'AcDbDictionary');
        s += this._pair(281, 1);

        // ── Model space LAYOUT object ────────────────────────────────
        s += this._pair(0, 'LAYOUT');
        s += this._pair(5, this.modelLayoutHandle);
        s += this._pair(330, this.layoutDictHandle);
        // AcDbPlotSettings subclass (required header for LAYOUT)
        s += this._pair(100, 'AcDbPlotSettings');
        s += this._pair(1, '');    // printer/plotter name
        s += this._pair(2, '');    // plotter config name
        s += this._pair(4, '');    // paper size
        s += this._pair(6, '');    // plot view name
        s += this._pair(40, '0.0');
        s += this._pair(41, '0.0');
        s += this._pair(42, '0.0');
        s += this._pair(43, '0.0');
        s += this._pair(44, '0.0');
        s += this._pair(45, '0.0');
        s += this._pair(46, '0.0');
        s += this._pair(47, '0.0');
        s += this._pair(48, '0.0');
        s += this._pair(49, '0.0');
        s += this._pair(140, '0.0');
        s += this._pair(141, '0.0');
        s += this._pair(142, '1.0');
        s += this._pair(143, '1.0');
        s += this._pair(70, 0);
        s += this._pair(72, 0);
        s += this._pair(73, 0);
        s += this._pair(74, 5);
        s += this._pair(75, 0);
        s += this._pair(76, 0);
        s += this._pair(77, 2);
        s += this._pair(78, 300);
        s += this._pair(147, '1.0');
        s += this._pair(148, '0.0');
        s += this._pair(149, '0.0');
        // AcDbLayout subclass
        s += this._pair(100, 'AcDbLayout');
        s += this._pair(1, 'Model');   // layout name
        s += this._pair(70, 1);        // layout flags
        s += this._pair(71, 0);        // tab order (0 = model)
        s += this._pair(10, '0.0');    // limmin X
        s += this._pair(20, '0.0');    // limmin Y
        s += this._pair(11, this.boundsMaxX.toFixed(6));  // limmax X
        s += this._pair(21, this.boundsMaxY.toFixed(6));  // limmax Y
        s += this._pair(12, this.viewCenterX.toFixed(6)); // insert base X
        s += this._pair(22, this.viewCenterY.toFixed(6)); // insert base Y
        s += this._pair(32, '0.0');
        s += this._pair(14, this.boundsMinX.toFixed(6));  // extmin X
        s += this._pair(24, this.boundsMinY.toFixed(6));  // extmin Y
        s += this._pair(34, '0.0');
        s += this._pair(15, this.boundsMaxX.toFixed(6));  // extmax X
        s += this._pair(25, this.boundsMaxY.toFixed(6));  // extmax Y
        s += this._pair(35, '0.0');
        s += this._pair(146, '0.0');   // elevation
        s += this._pair(13, '0.0');    // UCS origin X
        s += this._pair(23, '0.0');    // UCS origin Y
        s += this._pair(33, '0.0');
        s += this._pair(16, '1.0');    // UCS X-axis X
        s += this._pair(26, '0.0');
        s += this._pair(36, '0.0');
        s += this._pair(17, '0.0');    // UCS Y-axis X
        s += this._pair(27, '1.0');
        s += this._pair(37, '0.0');
        s += this._pair(76, 0);        // shade plot
        // Block record reference for this layout (group 330 inside AcDbLayout)
        s += this._pair(330, this.modelSpaceBlockRecordHandle);

        // ── Paper space (Layout1) LAYOUT object ──────────────────────
        s += this._pair(0, 'LAYOUT');
        s += this._pair(5, this.layout1Handle);
        s += this._pair(330, this.layoutDictHandle);
        s += this._pair(100, 'AcDbPlotSettings');
        s += this._pair(1, '');
        s += this._pair(2, '');
        s += this._pair(4, 'A4');
        s += this._pair(6, '');
        s += this._pair(40, '0.0');
        s += this._pair(41, '0.0');
        s += this._pair(42, '0.0');
        s += this._pair(43, '0.0');
        s += this._pair(44, '0.0');
        s += this._pair(45, '0.0');
        s += this._pair(46, '0.0');
        s += this._pair(47, '0.0');
        s += this._pair(48, '0.0');
        s += this._pair(49, '0.0');
        s += this._pair(140, '0.0');
        s += this._pair(141, '0.0');
        s += this._pair(142, '1.0');
        s += this._pair(143, '1.0');
        s += this._pair(70, 0);
        s += this._pair(72, 0);
        s += this._pair(73, 0);
        s += this._pair(74, 5);
        s += this._pair(75, 0);
        s += this._pair(76, 0);
        s += this._pair(77, 2);
        s += this._pair(78, 300);
        s += this._pair(147, '1.0');
        s += this._pair(148, '0.0');
        s += this._pair(149, '0.0');
        s += this._pair(100, 'AcDbLayout');
        s += this._pair(1, 'Layout1');
        s += this._pair(70, 1);
        s += this._pair(71, 1);        // tab order 1
        s += this._pair(10, '0.0');
        s += this._pair(20, '0.0');
        s += this._pair(11, '297.0');
        s += this._pair(21, '210.0');
        s += this._pair(12, '0.0');
        s += this._pair(22, '0.0');
        s += this._pair(32, '0.0');
        s += this._pair(14, '0.0');
        s += this._pair(24, '0.0');
        s += this._pair(34, '0.0');
        s += this._pair(15, '297.0');
        s += this._pair(25, '210.0');
        s += this._pair(35, '0.0');
        s += this._pair(146, '0.0');
        s += this._pair(13, '0.0');
        s += this._pair(23, '0.0');
        s += this._pair(33, '0.0');
        s += this._pair(16, '1.0');
        s += this._pair(26, '0.0');
        s += this._pair(36, '0.0');
        s += this._pair(17, '0.0');
        s += this._pair(27, '1.0');
        s += this._pair(37, '0.0');
        s += this._pair(76, 0);
        s += this._pair(330, this.paperSpaceBlockRecordHandle);

        // ── ACAD_PLOTSTYLENAME dictionary ────────────────────────────
        // Required by AutoCAD 2004+ (AC1018+): each LAYER entry references
        // a PlotStyleName via group code 390. We provide a single "Normal"
        // entry which corresponds to colour-dependent (CTB) plotting.
        s += this._pair(0, 'DICTIONARY');
        s += this._pair(5, this.plotStyleNameDictHandle);
        s += this._pair(330, this.namedObjsDictHandle);
        s += this._pair(100, 'AcDbDictionary');
        s += this._pair(281, 1);
        s += this._pair(3, 'Normal');
        s += this._pair(350, this.normalPlotStyleHandle);

        // ── Normal PLOTSTYLENAME object ──────────────────────────────
        s += this._pair(0, 'PLOTSTYLENAME');
        s += this._pair(5, this.normalPlotStyleHandle);
        s += this._pair(330, this.plotStyleNameDictHandle);
        s += this._pair(100, 'AcDbPlaceHolder');

        s += this._pair(0, 'ENDSEC');
        return s;
    }

    // ── Download ────────────────────────────────────────────────────

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

    // ── Stats ────────────────────────────────────────────────────────

    getStats() {
        const stats = { total: this.entities.length };
        for (const e of this.entities) {
            stats[e.type] = (stats[e.type] || 0) + 1;
        }
        return stats;
    }
}
