/**
 * ImageProcessor - Advanced image analysis pipeline using OpenCV.js
 * Handles: preprocessing, edge detection, contour extraction, Hough line detection,
 * circle detection, architectural shape recognition, and OCR text recognition.
 */
class ImageProcessor {
    constructor() {
        this.sourceImage = null;   // Original cv.Mat
        this.processed = null;     // Preprocessed grayscale
        this.edges = null;         // Canny edge result
        this.contours = [];        // Extracted contour data
        this.lines = [];           // Detected lines [{x1,y1,x2,y2}]
        this.circles = [];         // Detected circles [{cx,cy,r}]
        this.textBlocks = [];      // OCR results [{text,x,y,w,h,confidence}]

        // Architectural elements (recognized from primitives)
        this.walls = [];           // [{x1,y1,x2,y2, thickness}]
        this.doors = [];           // [{cx,cy,radius,startAngle,endAngle,hingePt,swingPt}]
        this.windows = [];         // [{x1,y1,x2,y2, width}]
        this.rooms = [];           // [{points, area, label}]

        this.imgWidth = 0;
        this.imgHeight = 0;
    }

    /**
     * Load image from an HTMLImageElement or canvas
     */
    loadFromImage(imgElement) {
        this.cleanup();
        this.sourceImage = cv.imread(imgElement);
        this.imgWidth = this.sourceImage.cols;
        this.imgHeight = this.sourceImage.rows;
    }

    /**
     * Run the full preprocessing pipeline
     */
    preprocess(options = {}) {
        const {
            grayscale = true,
            invert = false,
            denoise = true
        } = options;

        let mat = this.sourceImage.clone();

        // Convert to grayscale
        if (grayscale && mat.channels() > 1) {
            const gray = new cv.Mat();
            cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
            mat.delete();
            mat = gray;
        } else if (mat.channels() === 4) {
            const rgb = new cv.Mat();
            cv.cvtColor(mat, rgb, cv.COLOR_RGBA2GRAY);
            mat.delete();
            mat = rgb;
        }

        // Denoise
        if (denoise) {
            const denoised = new cv.Mat();
            cv.GaussianBlur(mat, denoised, new cv.Size(3, 3), 0);
            mat.delete();
            mat = denoised;
        }

        // Invert
        if (invert) {
            const inverted = new cv.Mat();
            cv.bitwise_not(mat, inverted);
            mat.delete();
            mat = inverted;
        }

        // Adaptive threshold for better binarization
        const binary = new cv.Mat();
        cv.adaptiveThreshold(mat, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv.THRESH_BINARY, 11, 2);

        if (this.processed) this.processed.delete();
        this.processed = mat;
        this.binarized = binary;

        return this.processed;
    }

    /**
     * Run Canny edge detection
     */
    detectEdges(lowThreshold = 50, highThreshold = 150) {
        if (!this.processed) throw new Error('Run preprocess() first');

        if (this.edges) this.edges.delete();
        this.edges = new cv.Mat();
        cv.Canny(this.processed, this.edges, lowThreshold, highThreshold);

        // Dilate slightly to connect nearby edges
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        const dilated = new cv.Mat();
        cv.dilate(this.edges, dilated, kernel);
        this.edges.delete();
        this.edges = dilated;
        kernel.delete();

        return this.edges;
    }

    /**
     * Extract contours from edge image
     */
    extractContours(minArea = 100, epsilon = 5) {
        if (!this.edges) throw new Error('Run detectEdges() first');

        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(this.edges, contours, hierarchy,
            cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

        this.contours = [];

        for (let i = 0; i < contours.size(); i++) {
            const contour = contours.get(i);
            const area = cv.contourArea(contour);

            if (area < minArea) continue;

            // Approximate the contour to reduce point count
            const approx = new cv.Mat();
            const peri = cv.arcLength(contour, true);
            cv.approxPolyDP(contour, approx, epsilon, true);

            // Extract points
            const points = [];
            for (let j = 0; j < approx.rows; j++) {
                points.push([
                    approx.data32S[j * 2],
                    approx.data32S[j * 2 + 1]
                ]);
            }

            // Classify the contour shape
            const shape = this._classifyShape(approx, area, peri);

            // Get hierarchy info: [next, prev, child, parent]
            const h = [
                hierarchy.data32S[i * 4],
                hierarchy.data32S[i * 4 + 1],
                hierarchy.data32S[i * 4 + 2],
                hierarchy.data32S[i * 4 + 3]
            ];

            this.contours.push({
                points,
                area,
                perimeter: peri,
                shape,
                isOuter: h[3] === -1,
                hasChildren: h[2] !== -1,
                parentIndex: h[3],
                boundingRect: cv.boundingRect(contour),
                vertexCount: approx.rows
            });

            approx.delete();
        }

        contours.delete();
        hierarchy.delete();

        // Sort by area descending (largest first = walls/boundaries)
        this.contours.sort((a, b) => b.area - a.area);

        return this.contours;
    }

    /**
     * Classify a contour shape
     */
    _classifyShape(approx, area, perimeter) {
        const vertices = approx.rows;
        const circularity = (4 * Math.PI * area) / (perimeter * perimeter);

        if (vertices === 3) return 'triangle';
        if (vertices === 4) {
            const rect = cv.boundingRect(approx);
            const aspectRatio = rect.width / rect.height;
            if (aspectRatio > 0.85 && aspectRatio < 1.15) return 'square';
            return 'rectangle';
        }
        if (vertices > 6 && circularity > 0.7) return 'circle';
        if (vertices === 5) return 'pentagon';
        if (vertices === 6) return 'hexagon';
        return 'polygon';
    }

    /**
     * Detect straight lines using Probabilistic Hough Transform
     */
    detectLines(options = {}) {
        if (!this.edges) throw new Error('Run detectEdges() first');

        const {
            threshold = 80,
            minLineLength = 30,
            maxLineGap = 10
        } = options;

        const linesMat = new cv.Mat();
        cv.HoughLinesP(this.edges, linesMat, 1, Math.PI / 180,
            threshold, minLineLength, maxLineGap);

        this.lines = [];
        for (let i = 0; i < linesMat.rows; i++) {
            const x1 = linesMat.data32S[i * 4];
            const y1 = linesMat.data32S[i * 4 + 1];
            const x2 = linesMat.data32S[i * 4 + 2];
            const y2 = linesMat.data32S[i * 4 + 3];

            const length = Math.hypot(x2 - x1, y2 - y1);
            const angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);

            this.lines.push({ x1, y1, x2, y2, length, angle });
        }

        linesMat.delete();

        // Merge nearly-collinear lines that are close together
        this.lines = this._mergeCollinearLines(this.lines);

        return this.lines;
    }

    /**
     * Merge lines that are nearly collinear and close together
     */
    _mergeCollinearLines(lines, angleTolerance = 5, distanceTolerance = 8) {
        if (lines.length === 0) return lines;

        const merged = [];
        const used = new Set();

        for (let i = 0; i < lines.length; i++) {
            if (used.has(i)) continue;
            let line = { ...lines[i] };
            used.add(i);

            for (let j = i + 1; j < lines.length; j++) {
                if (used.has(j)) continue;
                const other = lines[j];

                // Check angle similarity
                let angleDiff = Math.abs(line.angle - other.angle);
                if (angleDiff > 180) angleDiff = 360 - angleDiff;
                if (angleDiff > angleTolerance && Math.abs(angleDiff - 180) > angleTolerance) continue;

                // Check proximity
                const midX = (other.x1 + other.x2) / 2;
                const midY = (other.y1 + other.y2) / 2;
                const dist = this._pointToLineDistance(midX, midY, line.x1, line.y1, line.x2, line.y2);

                if (dist < distanceTolerance) {
                    // Merge: extend the line to encompass both
                    const allX = [line.x1, line.x2, other.x1, other.x2];
                    const allY = [line.y1, line.y2, other.y1, other.y2];

                    const dx = line.x2 - line.x1;
                    const dy = line.y2 - line.y1;
                    const len = Math.hypot(dx, dy);
                    if (len === 0) continue;
                    const ux = dx / len;
                    const uy = dy / len;

                    let minProj = Infinity, maxProj = -Infinity;
                    let minIdx = 0, maxIdx = 0;
                    for (let k = 0; k < allX.length; k++) {
                        const proj = (allX[k] - line.x1) * ux + (allY[k] - line.y1) * uy;
                        if (proj < minProj) { minProj = proj; minIdx = k; }
                        if (proj > maxProj) { maxProj = proj; maxIdx = k; }
                    }

                    line.x1 = allX[minIdx];
                    line.y1 = allY[minIdx];
                    line.x2 = allX[maxIdx];
                    line.y2 = allY[maxIdx];
                    line.length = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
                    used.add(j);
                }
            }
            merged.push(line);
        }

        return merged;
    }

    _pointToLineDistance(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.hypot(px - x1, py - y1);
        const num = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1);
        return num / Math.sqrt(lenSq);
    }

    /**
     * Detect circles using Hough Circle Transform
     */
    detectCircles(minRadius = 10, maxRadius = 200) {
        if (!this.processed) throw new Error('Run preprocess() first');

        const circles = new cv.Mat();
        cv.HoughCircles(this.processed, circles, cv.HOUGH_GRADIENT,
            1, 30, 100, 50, minRadius, maxRadius);

        this.circles = [];
        for (let i = 0; i < circles.cols; i++) {
            this.circles.push({
                cx: circles.data32F[i * 3],
                cy: circles.data32F[i * 3 + 1],
                radius: circles.data32F[i * 3 + 2]
            });
        }
        circles.delete();

        return this.circles;
    }

    /**
     * Run OCR text detection using Tesseract.js
     */
    async detectText(canvas) {
        this.textBlocks = [];

        try {
            const result = await Tesseract.recognize(canvas, 'eng', {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        const pct = Math.round(m.progress * 100);
                        document.getElementById('loadingText').textContent =
                            `OCR Processing: ${pct}%`;
                    }
                }
            });

            for (const word of result.data.words) {
                if (word.confidence < 40) continue;
                if (word.text.trim().length === 0) continue;

                this.textBlocks.push({
                    text: word.text.trim(),
                    x: word.bbox.x0,
                    y: word.bbox.y0,
                    w: word.bbox.x1 - word.bbox.x0,
                    h: word.bbox.y1 - word.bbox.y0,
                    confidence: word.confidence
                });
            }
        } catch (err) {
            console.warn('OCR failed:', err);
        }

        return this.textBlocks;
    }

    // ══════════════════════════════════════════════════════════════════
    //  SMART SHAPE RECOGNITION - Deduplicate + recognize architecture
    // ══════════════════════════════════════════════════════════════════

    /**
     * Main entry: deduplicate primitives and recognize architectural elements.
     * Call this AFTER detectLines, extractContours, detectCircles.
     */
    recognizeShapes() {
        // Step 1: Remove Hough lines that duplicate contour edges
        this._deduplicateLines();

        // Step 2: Remove duplicate/overlapping circles
        this._deduplicateCircles();

        // Step 3: Detect walls (long lines or elongated rectangles)
        this._detectWalls();

        // Step 4: Detect doors (arc near a wall gap)
        this._detectDoors();

        // Step 5: Detect windows (parallel short lines in a wall gap)
        this._detectWindows();

        // Step 6: Detect rooms (large closed contours)
        this._detectRooms();

        // Step 7: Classify remaining contours into furniture vs structure
        this._classifyRemainingContours();

        return {
            walls: this.walls,
            doors: this.doors,
            windows: this.windows,
            rooms: this.rooms
        };
    }

    /**
     * Remove Hough lines that overlap with contour edges.
     * A Hough line is redundant if it runs along an edge of an existing contour.
     */
    _deduplicateLines() {
        if (this.contours.length === 0 || this.lines.length === 0) return;

        // Build a set of contour edge segments
        const contourSegments = [];
        for (const contour of this.contours) {
            const pts = contour.points;
            for (let i = 0; i < pts.length; i++) {
                const a = pts[i];
                const b = pts[(i + 1) % pts.length];
                contourSegments.push({
                    x1: a[0], y1: a[1],
                    x2: b[0], y2: b[1],
                    angle: Math.atan2(b[1] - a[1], b[0] - a[0]) * (180 / Math.PI),
                    length: Math.hypot(b[0] - a[0], b[1] - a[1])
                });
            }
        }

        const keepLines = [];
        for (const line of this.lines) {
            let isDuplicate = false;
            const midX = (line.x1 + line.x2) / 2;
            const midY = (line.y1 + line.y2) / 2;

            for (const seg of contourSegments) {
                if (seg.length < 5) continue;

                // Check angle similarity
                let angleDiff = Math.abs(line.angle - seg.angle);
                if (angleDiff > 180) angleDiff = 360 - angleDiff;
                if (angleDiff > 8 && Math.abs(angleDiff - 180) > 8) continue;

                // Check if midpoint of Hough line is close to contour segment
                const dist = this._pointToLineDistance(midX, midY, seg.x1, seg.y1, seg.x2, seg.y2);
                if (dist < 12) {
                    // Also check that the contour segment overlaps in projection
                    const dx = seg.x2 - seg.x1;
                    const dy = seg.y2 - seg.y1;
                    const len = Math.hypot(dx, dy);
                    if (len === 0) continue;
                    const ux = dx / len;
                    const uy = dy / len;

                    const projMid = (midX - seg.x1) * ux + (midY - seg.y1) * uy;
                    if (projMid > -15 && projMid < len + 15) {
                        isDuplicate = true;
                        break;
                    }
                }
            }

            if (!isDuplicate) {
                keepLines.push(line);
            }
        }

        this.lines = keepLines;
    }

    /**
     * Remove overlapping/duplicate circles
     */
    _deduplicateCircles() {
        if (this.circles.length < 2) return;

        const keep = [];
        const used = new Set();

        // Sort by radius descending so we keep larger circles
        const sorted = this.circles.map((c, i) => ({ ...c, idx: i }))
            .sort((a, b) => b.radius - a.radius);

        for (const circle of sorted) {
            if (used.has(circle.idx)) continue;
            used.add(circle.idx);

            // Mark all nearby similar circles as duplicates
            for (const other of sorted) {
                if (used.has(other.idx)) continue;
                const dist = Math.hypot(circle.cx - other.cx, circle.cy - other.cy);
                const radiusDiff = Math.abs(circle.radius - other.radius);
                // If centers are close and radii are similar, it's a duplicate
                if (dist < Math.max(circle.radius, other.radius) * 0.5 && radiusDiff < circle.radius * 0.4) {
                    used.add(other.idx);
                }
            }

            keep.push({ cx: circle.cx, cy: circle.cy, radius: circle.radius });
        }

        this.circles = keep;
    }

    /**
     * Detect walls: long parallel line pairs or elongated rectangles
     */
    _detectWalls() {
        this.walls = [];
        const usedLineIndices = new Set();
        const usedContourIndices = new Set();

        // Method 1: Elongated rectangular contours -> walls
        for (let i = 0; i < this.contours.length; i++) {
            const c = this.contours[i];
            if (c.shape !== 'rectangle') continue;
            const r = c.boundingRect;
            const aspect = Math.max(r.width, r.height) / Math.min(r.width, r.height);

            // Wall-like: long and thin (aspect > 4) and above minimum size
            if (aspect > 4 && Math.max(r.width, r.height) > 40) {
                const isHorizontal = r.width > r.height;
                if (isHorizontal) {
                    this.walls.push({
                        x1: r.x, y1: r.y + r.height / 2,
                        x2: r.x + r.width, y2: r.y + r.height / 2,
                        thickness: r.height,
                        fromContour: i
                    });
                } else {
                    this.walls.push({
                        x1: r.x + r.width / 2, y1: r.y,
                        x2: r.x + r.width / 2, y2: r.y + r.height,
                        thickness: r.width,
                        fromContour: i
                    });
                }
                usedContourIndices.add(i);
            }
        }

        // Method 2: Parallel Hough line pairs -> walls
        for (let i = 0; i < this.lines.length; i++) {
            if (usedLineIndices.has(i)) continue;
            const lineA = this.lines[i];
            if (lineA.length < 40) continue; // Must be substantial

            for (let j = i + 1; j < this.lines.length; j++) {
                if (usedLineIndices.has(j)) continue;
                const lineB = this.lines[j];
                if (lineB.length < 40) continue;

                // Check parallel (angle diff < 5 degrees)
                let angleDiff = Math.abs(lineA.angle - lineB.angle);
                if (angleDiff > 180) angleDiff = 360 - angleDiff;
                if (angleDiff > 5 && Math.abs(angleDiff - 180) > 5) continue;

                // Check distance between them (wall thickness 3-30px)
                const midAx = (lineA.x1 + lineA.x2) / 2;
                const midAy = (lineA.y1 + lineA.y2) / 2;
                const dist = this._pointToLineDistance(midAx, midAy, lineB.x1, lineB.y1, lineB.x2, lineB.y2);

                if (dist > 3 && dist < 30) {
                    // Check they overlap in the parallel direction
                    const overlap = this._lineOverlap(lineA, lineB);
                    if (overlap > 0.5) {
                        // Merge into a wall (centerline)
                        const cx1 = (lineA.x1 + lineB.x1) / 2;
                        const cy1 = (lineA.y1 + lineB.y1) / 2;
                        const cx2 = (lineA.x2 + lineB.x2) / 2;
                        const cy2 = (lineA.y2 + lineB.y2) / 2;

                        this.walls.push({
                            x1: cx1, y1: cy1,
                            x2: cx2, y2: cy2,
                            thickness: dist,
                            fromLines: [i, j]
                        });
                        usedLineIndices.add(i);
                        usedLineIndices.add(j);
                        break;
                    }
                }
            }
        }

        // Remove consumed lines
        this.lines = this.lines.filter((_, i) => !usedLineIndices.has(i));
        // Mark consumed contours
        for (const idx of usedContourIndices) {
            this.contours[idx]._consumed = true;
        }
    }

    /**
     * Compute overlap ratio between two parallel lines (0-1)
     */
    _lineOverlap(lineA, lineB) {
        // Project both lines onto the average direction
        const dx = lineA.x2 - lineA.x1;
        const dy = lineA.y2 - lineA.y1;
        const len = Math.hypot(dx, dy);
        if (len === 0) return 0;
        const ux = dx / len;
        const uy = dy / len;

        const projA1 = lineA.x1 * ux + lineA.y1 * uy;
        const projA2 = lineA.x2 * ux + lineA.y2 * uy;
        const projB1 = lineB.x1 * ux + lineB.y1 * uy;
        const projB2 = lineB.x2 * ux + lineB.y2 * uy;

        const minA = Math.min(projA1, projA2);
        const maxA = Math.max(projA1, projA2);
        const minB = Math.min(projB1, projB2);
        const maxB = Math.max(projB1, projB2);

        const overlapStart = Math.max(minA, minB);
        const overlapEnd = Math.min(maxA, maxB);

        if (overlapEnd <= overlapStart) return 0;

        const overlapLen = overlapEnd - overlapStart;
        const shorter = Math.min(maxA - minA, maxB - minB);
        return shorter > 0 ? overlapLen / shorter : 0;
    }

    /**
     * Detect doors: arc (quarter/half circle) near a wall endpoint.
     * In architectural drawings, doors are typically represented as an arc
     * showing the door swing, connected to the wall.
     */
    _detectDoors() {
        this.doors = [];
        const usedCircleIndices = new Set();
        const usedContourIndices = new Set();

        // Method 1: Look for quarter-circle arcs among contours
        // A door arc has many vertices (curved), high circularity, but is NOT a full circle
        for (let i = 0; i < this.contours.length; i++) {
            const c = this.contours[i];
            if (c._consumed) continue;

            // A door arc contour: roughly quarter-circle shape
            // - More than 4 vertices (curved)
            // - Bounding rect is roughly square (quarter circle fits in a square)
            // - Area is roughly pi*r^2/4 compared to bounding rect area
            const r = c.boundingRect;
            const bboxArea = r.width * r.height;
            if (bboxArea < 200) continue; // too small
            const areaRatio = c.area / bboxArea;

            const aspectRatio = r.width / r.height;
            const isSquarish = aspectRatio > 0.5 && aspectRatio < 2.0;

            // Quarter circle area / bbox area = (pi/4) ~= 0.785
            // But with approximation it could be 0.5-0.9
            const isQuarterArc = isSquarish && areaRatio > 0.35 && areaRatio < 0.85
                && c.vertexCount >= 5 && c.vertexCount <= 30;

            if (isQuarterArc) {
                // Determine arc center: corner of bounding box closest to a wall endpoint
                const radius = Math.max(r.width, r.height);
                const candidates = [
                    { cx: r.x, cy: r.y },                           // top-left
                    { cx: r.x + r.width, cy: r.y },                 // top-right
                    { cx: r.x, cy: r.y + r.height },                // bottom-left
                    { cx: r.x + r.width, cy: r.y + r.height }       // bottom-right
                ];

                // Pick the corner where the arc's points are farthest from
                let bestCorner = candidates[0];
                let bestScore = 0;
                for (const corner of candidates) {
                    let totalDist = 0;
                    for (const pt of c.points) {
                        totalDist += Math.hypot(pt[0] - corner.cx, pt[1] - corner.cy);
                    }
                    const avgDist = totalDist / c.points.length;
                    // The hinge corner will have points at ~radius distance
                    const score = -Math.abs(avgDist - radius);
                    if (score > bestScore || bestScore === 0) {
                        bestScore = score;
                        bestCorner = corner;
                    }
                }

                // Calculate start and end angles from the arc points
                const angles = c.points.map(pt =>
                    Math.atan2(pt[1] - bestCorner.cy, pt[0] - bestCorner.cx) * (180 / Math.PI)
                );
                const minAngle = Math.min(...angles);
                const maxAngle = Math.max(...angles);

                this.doors.push({
                    cx: bestCorner.cx,
                    cy: bestCorner.cy,
                    radius: radius,
                    startAngle: minAngle,
                    endAngle: maxAngle,
                    fromContour: i,
                    type: 'swing'
                });
                usedContourIndices.add(i);
            }
        }

        // Method 2: Circles near wall endpoints could be door swings
        for (let ci = 0; ci < this.circles.length; ci++) {
            if (usedCircleIndices.has(ci)) continue;
            const circle = this.circles[ci];

            // Check if this circle center is near a wall endpoint
            for (const wall of this.walls) {
                const distToStart = Math.hypot(circle.cx - wall.x1, circle.cy - wall.y1);
                const distToEnd = Math.hypot(circle.cx - wall.x2, circle.cy - wall.y2);
                const nearWall = Math.min(distToStart, distToEnd);

                // Circle center should be near wall endpoint, radius reasonable for a door
                if (nearWall < wall.thickness * 2 + 15 && circle.radius > 15 && circle.radius < 200) {
                    const hingePt = distToStart < distToEnd
                        ? { x: wall.x1, y: wall.y1 }
                        : { x: wall.x2, y: wall.y2 };

                    this.doors.push({
                        cx: hingePt.x,
                        cy: hingePt.y,
                        radius: circle.radius,
                        startAngle: 0,
                        endAngle: 90,
                        fromCircle: ci,
                        type: 'swing'
                    });
                    usedCircleIndices.add(ci);
                    break;
                }
            }
        }

        // Remove consumed circles and mark consumed contours
        this.circles = this.circles.filter((_, i) => !usedCircleIndices.has(i));
        for (const idx of usedContourIndices) {
            this.contours[idx]._consumed = true;
        }
    }

    /**
     * Detect windows: short parallel lines perpendicular to or within a wall gap
     * In floor plans, windows are often shown as parallel lines across a wall opening
     */
    _detectWindows() {
        this.windows = [];
        const usedLineIndices = new Set();

        // Look for groups of 2-3 short parallel lines that span a wall gap
        for (let i = 0; i < this.lines.length; i++) {
            if (usedLineIndices.has(i)) continue;
            const lineA = this.lines[i];
            if (lineA.length > 80 || lineA.length < 8) continue; // Windows are short-medium

            const group = [i];

            for (let j = i + 1; j < this.lines.length; j++) {
                if (usedLineIndices.has(j)) continue;
                const lineB = this.lines[j];
                if (lineB.length > 80 || lineB.length < 8) continue;

                // Must be parallel
                let angleDiff = Math.abs(lineA.angle - lineB.angle);
                if (angleDiff > 180) angleDiff = 360 - angleDiff;
                if (angleDiff > 5 && Math.abs(angleDiff - 180) > 5) continue;

                // Must be close and similar length
                const midBx = (lineB.x1 + lineB.x2) / 2;
                const midBy = (lineB.y1 + lineB.y2) / 2;
                const dist = this._pointToLineDistance(midBx, midBy, lineA.x1, lineA.y1, lineA.x2, lineA.y2);
                const lenRatio = Math.min(lineA.length, lineB.length) / Math.max(lineA.length, lineB.length);

                if (dist > 2 && dist < 15 && lenRatio > 0.7) {
                    group.push(j);
                }
            }

            if (group.length >= 2) {
                // Check if near a wall
                const midX = (lineA.x1 + lineA.x2) / 2;
                const midY = (lineA.y1 + lineA.y2) / 2;

                for (const wall of this.walls) {
                    const distToWall = this._pointToLineDistance(midX, midY, wall.x1, wall.y1, wall.x2, wall.y2);
                    if (distToWall < wall.thickness + 20) {
                        this.windows.push({
                            x1: lineA.x1, y1: lineA.y1,
                            x2: lineA.x2, y2: lineA.y2,
                            width: this._pointToLineDistance(
                                (this.lines[group[1]].x1 + this.lines[group[1]].x2) / 2,
                                (this.lines[group[1]].y1 + this.lines[group[1]].y2) / 2,
                                lineA.x1, lineA.y1, lineA.x2, lineA.y2
                            ),
                            fromLines: group
                        });
                        for (const idx of group) usedLineIndices.add(idx);
                        break;
                    }
                }
            }
        }

        this.lines = this.lines.filter((_, i) => !usedLineIndices.has(i));
    }

    /**
     * Detect rooms: large closed contours that represent enclosed spaces
     */
    _detectRooms() {
        this.rooms = [];
        const imageArea = this.imgWidth * this.imgHeight;

        for (let i = 0; i < this.contours.length; i++) {
            const c = this.contours[i];
            if (c._consumed) continue;

            // Rooms are large closed contours (>2% of image) with many vertices
            if (c.area > imageArea * 0.02 && c.isOuter && c.vertexCount >= 4) {
                this.rooms.push({
                    points: c.points,
                    area: c.area,
                    boundingRect: c.boundingRect,
                    fromContour: i
                });
                c._consumed = true;
            }
        }
    }

    /**
     * Classify remaining non-consumed contours into proper layers
     */
    _classifyRemainingContours() {
        for (const c of this.contours) {
            if (c._consumed) continue;

            // Small rectangles/squares near walls -> could be columns or fixtures
            if ((c.shape === 'rectangle' || c.shape === 'square') && c.area < 2000) {
                c.architecturalType = 'fixture';
            } else if (c.shape === 'circle') {
                c.architecturalType = 'fixture';
            } else if (c.shape === 'rectangle' || c.shape === 'square') {
                c.architecturalType = 'furniture';
            } else {
                c.architecturalType = 'other';
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  DXF BUILDING
    // ══════════════════════════════════════════════════════════════════

    /**
     * Build a DXF file from all detected + recognized features
     */
    buildDXF(scale = 1, flipY = true) {
        const dxf = new DXFWriter();
        const s = scale;
        const h = this.imgHeight;

        const ty = (y) => flipY ? (h - y) * s : y * s;
        const tx = (x) => x * s;

        // ── Add walls ──
        for (const wall of this.walls) {
            // Draw wall as two parallel lines (thickness)
            const dx = wall.x2 - wall.x1;
            const dy = wall.y2 - wall.y1;
            const len = Math.hypot(dx, dy);
            if (len === 0) continue;
            const nx = (-dy / len) * (wall.thickness / 2);
            const ny = (dx / len) * (wall.thickness / 2);

            dxf.addLine(
                tx(wall.x1 + nx), ty(wall.y1 + ny),
                tx(wall.x2 + nx), ty(wall.y2 + ny),
                'Walls'
            );
            dxf.addLine(
                tx(wall.x1 - nx), ty(wall.y1 - ny),
                tx(wall.x2 - nx), ty(wall.y2 - ny),
                'Walls'
            );
        }

        // ── Add doors (as arcs) ──
        for (const door of this.doors) {
            // DXF arcs use degrees, counter-clockwise from positive X
            // Flip Y means we need to adjust angles
            const cx = tx(door.cx);
            const cy = ty(door.cy);
            const r = door.radius * s;
            let startAngle = door.startAngle;
            let endAngle = door.endAngle;
            if (flipY) {
                startAngle = -door.endAngle;
                endAngle = -door.startAngle;
            }
            // Normalize to 0-360
            while (startAngle < 0) startAngle += 360;
            while (endAngle < 0) endAngle += 360;

            dxf.addArc(cx, cy, r, startAngle, endAngle, 'Doors');
        }

        // ── Add windows ──
        for (const win of this.windows) {
            dxf.addLine(
                tx(win.x1), ty(win.y1),
                tx(win.x2), ty(win.y2),
                'Windows'
            );
        }

        // ── Add rooms as boundaries ──
        for (const room of this.rooms) {
            const pts = room.points.map(([x, y]) => [tx(x), ty(y)]);
            dxf.addPolyline(pts, 'Boundaries', true);
        }

        // ── Add remaining (non-consumed) contours ──
        for (const contour of this.contours) {
            if (contour._consumed) continue;
            const pts = contour.points.map(([x, y]) => [tx(x), ty(y)]);

            let layer;
            if (contour.architecturalType === 'furniture') {
                layer = 'Furniture';
            } else if (contour.architecturalType === 'fixture') {
                layer = 'Fixtures';
            } else {
                layer = 'Detected_Contours';
            }

            if (contour.shape === 'circle' && contour.points.length > 6) {
                const rect = contour.boundingRect;
                const cx = tx(rect.x + rect.width / 2);
                const cy = ty(rect.y + rect.height / 2);
                const r = ((rect.width + rect.height) / 4) * s;
                dxf.addCircle(cx, cy, r, layer);
            } else {
                dxf.addPolyline(pts, layer, true);
            }
        }

        // ── Add remaining detected lines ──
        for (const line of this.lines) {
            dxf.addLine(
                tx(line.x1), ty(line.y1),
                tx(line.x2), ty(line.y2),
                'Detected_Lines'
            );
        }

        // ── Add remaining detected circles ──
        for (const circle of this.circles) {
            dxf.addCircle(tx(circle.cx), ty(circle.cy), circle.radius * s, 'Detected_Contours');
        }

        // ── Add text blocks ──
        for (const block of this.textBlocks) {
            const textHeight = Math.max(block.h * s * 0.7, 2.0);
            dxf.addText(
                block.text,
                tx(block.x),
                ty(block.y + block.h),
                textHeight,
                0,
                'Detected_Text'
            );
        }

        return dxf;
    }

    // ══════════════════════════════════════════════════════════════════
    //  PREVIEW RENDERING
    // ══════════════════════════════════════════════════════════════════

    /**
     * Draw detection results on a preview canvas with architectural overlays
     */
    drawPreview(canvas, options = {}) {
        const {
            showEdges = true,
            showContours = true,
            showLines = true,
            showText = true,
            showWalls = true,
            showDoors = true,
            showWindows = true,
            showRooms = true
        } = options;

        const ctx = canvas.getContext('2d');
        canvas.width = this.imgWidth;
        canvas.height = this.imgHeight;

        // Draw semi-transparent source image
        if (this.sourceImage) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.imgWidth;
            tempCanvas.height = this.imgHeight;
            cv.imshow(tempCanvas, this.sourceImage);
            ctx.globalAlpha = 0.3;
            ctx.drawImage(tempCanvas, 0, 0);
            ctx.globalAlpha = 1.0;
        }

        // Draw edges
        if (showEdges && this.edges) {
            const edgeCanvas = document.createElement('canvas');
            edgeCanvas.width = this.imgWidth;
            edgeCanvas.height = this.imgHeight;
            cv.imshow(edgeCanvas, this.edges);

            const edgeCtx = edgeCanvas.getContext('2d');
            const imageData = edgeCtx.getImageData(0, 0, this.imgWidth, this.imgHeight);
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i] > 128) {
                    data[i] = 255;
                    data[i + 1] = 107;
                    data[i + 2] = 107;
                    data[i + 3] = 150;
                } else {
                    data[i + 3] = 0;
                }
            }
            edgeCtx.putImageData(imageData, 0, 0);
            ctx.drawImage(edgeCanvas, 0, 0);
        }

        // Draw rooms (filled, semi-transparent)
        if (showRooms) {
            for (const room of this.rooms) {
                ctx.fillStyle = 'rgba(100, 200, 100, 0.08)';
                ctx.strokeStyle = '#64c864';
                ctx.lineWidth = 1;
                ctx.beginPath();
                const pts = room.points;
                if (pts.length === 0) continue;
                ctx.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) {
                    ctx.lineTo(pts[i][0], pts[i][1]);
                }
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }
        }

        // Draw walls (thick colored lines)
        if (showWalls) {
            ctx.strokeStyle = '#ff6b6b';
            ctx.lineWidth = 3;
            for (const wall of this.walls) {
                // Draw wall outline
                const dx = wall.x2 - wall.x1;
                const dy = wall.y2 - wall.y1;
                const len = Math.hypot(dx, dy);
                if (len === 0) continue;
                const nx = (-dy / len) * (wall.thickness / 2);
                const ny = (dx / len) * (wall.thickness / 2);

                ctx.fillStyle = 'rgba(255, 107, 107, 0.2)';
                ctx.beginPath();
                ctx.moveTo(wall.x1 + nx, wall.y1 + ny);
                ctx.lineTo(wall.x2 + nx, wall.y2 + ny);
                ctx.lineTo(wall.x2 - nx, wall.y2 - ny);
                ctx.lineTo(wall.x1 - nx, wall.y1 - ny);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }
        }

        // Draw doors (arc + hinge indicator)
        if (showDoors) {
            ctx.strokeStyle = '#ff9f43';
            ctx.lineWidth = 2.5;
            for (const door of this.doors) {
                const startRad = door.startAngle * (Math.PI / 180);
                const endRad = door.endAngle * (Math.PI / 180);

                ctx.beginPath();
                ctx.arc(door.cx, door.cy, door.radius, startRad, endRad);
                ctx.stroke();

                // Draw hinge point marker
                ctx.fillStyle = '#ff9f43';
                ctx.beginPath();
                ctx.arc(door.cx, door.cy, 4, 0, Math.PI * 2);
                ctx.fill();

                // Label
                ctx.font = '11px sans-serif';
                ctx.fillStyle = '#ff9f43';
                ctx.fillText('Door', door.cx + 6, door.cy - 6);
            }
        }

        // Draw windows
        if (showWindows) {
            ctx.strokeStyle = '#54a0ff';
            ctx.lineWidth = 3;
            for (const win of this.windows) {
                ctx.beginPath();
                ctx.moveTo(win.x1, win.y1);
                ctx.lineTo(win.x2, win.y2);
                ctx.stroke();

                // Label
                ctx.font = '10px sans-serif';
                ctx.fillStyle = '#54a0ff';
                ctx.fillText('Win', (win.x1 + win.x2) / 2, (win.y1 + win.y2) / 2 - 5);
            }
        }

        // Draw remaining contours (non-consumed only)
        if (showContours) {
            for (const contour of this.contours) {
                if (contour._consumed) continue;
                const pts = contour.points;
                if (pts.length === 0) continue;

                if (contour.architecturalType === 'furniture') {
                    ctx.strokeStyle = '#5f27cd';
                    ctx.lineWidth = 1.5;
                } else if (contour.architecturalType === 'fixture') {
                    ctx.strokeStyle = '#01a3a4';
                    ctx.lineWidth = 1.5;
                } else {
                    ctx.strokeStyle = '#4ecdc4';
                    ctx.lineWidth = 1;
                }

                ctx.beginPath();
                ctx.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) {
                    ctx.lineTo(pts[i][0], pts[i][1]);
                }
                ctx.closePath();
                ctx.stroke();
            }

            // Draw remaining circles
            ctx.strokeStyle = '#4ecdc4';
            ctx.lineWidth = 1.5;
            for (const c of this.circles) {
                ctx.beginPath();
                ctx.arc(c.cx, c.cy, c.radius, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        // Draw remaining lines
        if (showLines) {
            ctx.strokeStyle = '#ffd93d';
            ctx.lineWidth = 1.5;
            for (const line of this.lines) {
                ctx.beginPath();
                ctx.moveTo(line.x1, line.y1);
                ctx.lineTo(line.x2, line.y2);
                ctx.stroke();
            }
        }

        // Draw text blocks
        if (showText) {
            ctx.strokeStyle = '#a78bfa';
            ctx.fillStyle = 'rgba(167, 139, 250, 0.15)';
            ctx.lineWidth = 1.5;
            ctx.font = '12px monospace';

            for (const block of this.textBlocks) {
                ctx.fillRect(block.x, block.y, block.w, block.h);
                ctx.strokeRect(block.x, block.y, block.w, block.h);
                ctx.fillStyle = '#a78bfa';
                ctx.fillText(block.text, block.x, block.y - 3);
                ctx.fillStyle = 'rgba(167, 139, 250, 0.15)';
            }
        }
    }

    /**
     * Clean up OpenCV mats
     */
    cleanup() {
        if (this.sourceImage) { this.sourceImage.delete(); this.sourceImage = null; }
        if (this.processed) { this.processed.delete(); this.processed = null; }
        if (this.edges) { this.edges.delete(); this.edges = null; }
        if (this.binarized) { this.binarized.delete(); this.binarized = null; }
        this.contours = [];
        this.lines = [];
        this.circles = [];
        this.textBlocks = [];
        this.walls = [];
        this.doors = [];
        this.windows = [];
        this.rooms = [];
    }
}
