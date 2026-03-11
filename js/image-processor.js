/**
 * ImageProcessor - Advanced image analysis pipeline using OpenCV.js
 * Handles: preprocessing, edge detection, contour extraction, Hough line detection,
 * circle detection, and OCR text recognition via Tesseract.js
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
            // Check if it's a rectangle by comparing aspect ratio
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

                    // Project onto the line direction to find extremes
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
                if (word.confidence < 40) continue; // Skip low-confidence words
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

    /**
     * Build a DXF file from all detected features
     */
    buildDXF(scale = 1, flipY = true) {
        const dxf = new DXFWriter();
        const s = scale;
        const h = this.imgHeight;

        // Helper to flip Y (image coords are top-down, DXF is bottom-up)
        const ty = (y) => flipY ? (h - y) * s : y * s;
        const tx = (x) => x * s;

        // ── Add detected lines ──
        for (const line of this.lines) {
            dxf.addLine(
                tx(line.x1), ty(line.y1),
                tx(line.x2), ty(line.y2),
                'Detected_Lines'
            );
        }

        // ── Add contours ──
        for (const contour of this.contours) {
            const pts = contour.points.map(([x, y]) => [tx(x), ty(y)]);

            // Large contours = walls/boundaries, small = furniture
            let layer;
            if (contour.isOuter && contour.area > (this.imgWidth * this.imgHeight * 0.01)) {
                layer = 'Boundaries';
            } else if (contour.shape === 'rectangle' || contour.shape === 'square') {
                layer = 'Furniture';
            } else {
                layer = 'Detected_Contours';
            }

            if (contour.shape === 'circle' && contour.points.length > 6) {
                // Convert to circle entity
                const rect = contour.boundingRect;
                const cx = tx(rect.x + rect.width / 2);
                const cy = ty(rect.y + rect.height / 2);
                const r = ((rect.width + rect.height) / 4) * s;
                dxf.addCircle(cx, cy, r, layer);
            } else {
                dxf.addPolyline(pts, layer, true);
            }
        }

        // ── Add detected circles ──
        for (const circle of this.circles) {
            dxf.addCircle(tx(circle.cx), ty(circle.cy), circle.radius * s, 'Furniture');
        }

        // ── Add text blocks ──
        for (const block of this.textBlocks) {
            const textHeight = Math.max(block.h * s * 0.7, 2.0);
            dxf.addText(
                block.text,
                tx(block.x),
                ty(block.y + block.h), // Bottom-left of text
                textHeight,
                0,
                'Detected_Text'
            );
        }

        return dxf;
    }

    /**
     * Draw detection results on a preview canvas
     */
    drawPreview(canvas, options = {}) {
        const {
            showEdges = true,
            showContours = true,
            showLines = true,
            showText = true
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

            // Colorize edges red
            const edgeCtx = edgeCanvas.getContext('2d');
            const imageData = edgeCtx.getImageData(0, 0, this.imgWidth, this.imgHeight);
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i] > 128) {
                    data[i] = 255;     // R
                    data[i + 1] = 107; // G
                    data[i + 2] = 107; // B
                    data[i + 3] = 150; // A
                } else {
                    data[i + 3] = 0;
                }
            }
            edgeCtx.putImageData(imageData, 0, 0);
            ctx.drawImage(edgeCanvas, 0, 0);
        }

        // Draw contours
        if (showContours) {
            ctx.strokeStyle = '#4ecdc4';
            ctx.lineWidth = 2;
            for (const contour of this.contours) {
                ctx.beginPath();
                const pts = contour.points;
                if (pts.length === 0) continue;
                ctx.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) {
                    ctx.lineTo(pts[i][0], pts[i][1]);
                }
                ctx.closePath();
                ctx.stroke();
            }

            // Draw circles
            ctx.strokeStyle = '#4ecdc4';
            for (const c of this.circles) {
                ctx.beginPath();
                ctx.arc(c.cx, c.cy, c.radius, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        // Draw lines
        if (showLines) {
            ctx.strokeStyle = '#ffd93d';
            ctx.lineWidth = 2;
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
                // Bounding box
                ctx.fillRect(block.x, block.y, block.w, block.h);
                ctx.strokeRect(block.x, block.y, block.w, block.h);

                // Text label
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
    }
}
