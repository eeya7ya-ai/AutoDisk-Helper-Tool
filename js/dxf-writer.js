/**
 * DXF Writer - Generates AutoCAD DXF R2010 files from detected geometry.
 * Supports: LINE, LWPOLYLINE, CIRCLE, ARC, TEXT, MTEXT, DIMENSION entities.
 * Organizes output into layers: Walls, Furniture, Boundaries, Text, Dimensions.
 */
class DXFWriter {
    constructor() {
        this.entities = [];
        this.layers = new Map();
        this.handleCounter = 100;
        this.defaultTextHeight = 2.5;

        // Define standard layers with AutoCAD color indices
        this.addLayer('0', 7);              // Default - white
        this.addLayer('Walls', 1);          // Red
        this.addLayer('Boundaries', 3);     // Green
        this.addLayer('Doors', 30);         // Orange
        this.addLayer('Windows', 150);      // Blue-ish
        this.addLayer('Furniture', 5);      // Blue
        this.addLayer('Fixtures', 4);       // Cyan
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
        let dxf = '';
        dxf += this._headerSection();
        dxf += this._tablesSection();
        dxf += this._blocksSection();
        dxf += this._entitiesSection();
        dxf += this._objectsSection();
        dxf += '  0\nEOF\n';
        return dxf;
    }

    _pair(code, value) {
        return `${code.toString().padStart(3)}\n${value}\n`;
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

        // Drawing extents
        s += this._pair(9, '$EXTMIN');
        s += this._pair(10, '0.0');
        s += this._pair(20, '0.0');
        s += this._pair(30, '0.0');

        s += this._pair(9, '$EXTMAX');
        s += this._pair(10, '1000.0');
        s += this._pair(20, '1000.0');
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

        // VPORT table
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'VPORT');
        s += this._pair(5, this._nextHandle());
        s += this._pair(70, 0);
        s += this._pair(0, 'ENDTAB');

        // LTYPE table
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'LTYPE');
        s += this._pair(5, this._nextHandle());
        s += this._pair(70, 1);

        // CONTINUOUS linetype
        s += this._pair(0, 'LTYPE');
        s += this._pair(5, this._nextHandle());
        s += this._pair(2, 'CONTINUOUS');
        s += this._pair(70, 0);
        s += this._pair(3, 'Solid line');
        s += this._pair(72, 65);
        s += this._pair(73, 0);
        s += this._pair(40, '0.0');

        s += this._pair(0, 'ENDTAB');

        // LAYER table
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'LAYER');
        s += this._pair(5, this._nextHandle());
        s += this._pair(70, this.layers.size);

        for (const [name, layer] of this.layers) {
            s += this._pair(0, 'LAYER');
            s += this._pair(5, this._nextHandle());
            s += this._pair(2, name);
            s += this._pair(70, 0);
            s += this._pair(62, layer.colorIndex);
            s += this._pair(6, layer.lineType);
        }

        s += this._pair(0, 'ENDTAB');

        // STYLE table (ARIAL text style)
        s += this._pair(0, 'TABLE');
        s += this._pair(2, 'STYLE');
        s += this._pair(5, this._nextHandle());
        s += this._pair(70, 1);

        s += this._pair(0, 'STYLE');
        s += this._pair(5, this._nextHandle());
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

        s += this._pair(0, 'ENDSEC');
        return s;
    }

    _blocksSection() {
        let s = '';
        s += this._pair(0, 'SECTION');
        s += this._pair(2, 'BLOCKS');
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
                s += this._pair(8, e.layer);
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
                s += this._pair(8, e.layer);
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
                s += this._pair(8, e.layer);
                s += this._pair(10, e.cx.toFixed(6));
                s += this._pair(20, e.cy.toFixed(6));
                s += this._pair(30, '0.0');
                s += this._pair(40, e.radius.toFixed(6));
                break;

            case 'ARC':
                s += this._pair(0, 'ARC');
                s += this._pair(5, this._nextHandle());
                s += this._pair(8, e.layer);
                s += this._pair(10, e.cx.toFixed(6));
                s += this._pair(20, e.cy.toFixed(6));
                s += this._pair(30, '0.0');
                s += this._pair(40, e.radius.toFixed(6));
                s += this._pair(50, e.startAngle.toFixed(6));
                s += this._pair(51, e.endAngle.toFixed(6));
                break;

            case 'TEXT':
                s += this._pair(0, 'TEXT');
                s += this._pair(5, this._nextHandle());
                s += this._pair(8, e.layer);
                s += this._pair(7, 'ARIAL');
                s += this._pair(10, e.x.toFixed(6));
                s += this._pair(20, e.y.toFixed(6));
                s += this._pair(30, '0.0');
                s += this._pair(40, e.height.toFixed(6));
                s += this._pair(50, e.rotation.toFixed(6));
                s += this._pair(1, e.text);
                break;

            case 'MTEXT':
                s += this._pair(0, 'MTEXT');
                s += this._pair(5, this._nextHandle());
                s += this._pair(8, e.layer);
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
        s += this._pair(0, 'DICTIONARY');
        s += this._pair(5, this._nextHandle());
        s += this._pair(0, 'ENDSEC');
        return s;
    }

    /**
     * Generate and trigger a browser download
     */
    download(filename = 'output.dxf') {
        const content = this.generate();
        const blob = new Blob([content], { type: 'application/dxf' });
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
