/**
 * App Controller - Wires together UI, ImageProcessor, and DXFWriter
 */

let cvReady = false;
let processor = null;
let currentImage = null;
let lastDXF = null;

// ── OpenCV Ready ────────────────────────────────────────────────────

function onOpenCVReady() {
    cvReady = true;
    console.log('OpenCV.js loaded');
}

// ── DOM Elements ────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const dropZone = $('dropZone');
const fileInput = $('fileInput');
const uploadSection = $('upload-section');
const controlsSection = $('controls-section');
const sourceCanvas = $('sourceCanvas');
const previewCanvas = $('previewCanvas');
const loadingOverlay = $('loadingOverlay');
const loadingText = $('loadingText');
const progressBar = $('progressBar');
const statusText = $('statusText');

// Sliders
const sliders = {
    cannyLow: $('cannyLow'),
    cannyHigh: $('cannyHigh'),
    minArea: $('minArea'),
    epsilon: $('epsilon'),
    houghThreshold: $('houghThreshold'),
    houghMinLen: $('houghMinLen'),
    houghMaxGap: $('houghMaxGap')
};

// ── File Upload Handling ────────────────────────────────────────────

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
        loadImage(file);
    }
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadImage(file);
});

$('btnChangeImage').addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
});

function loadImage(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            currentImage = img;
            showSourceImage(img);
            uploadSection.style.display = 'none';
            controlsSection.style.display = 'block';
            statusText.textContent = `Loaded: ${file.name} (${img.width}x${img.height})`;
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function showSourceImage(img) {
    sourceCanvas.width = img.width;
    sourceCanvas.height = img.height;
    const ctx = sourceCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
}

// ── Slider Live Updates ─────────────────────────────────────────────

for (const [key, slider] of Object.entries(sliders)) {
    const valSpan = $(key + 'Val');
    slider.addEventListener('input', () => {
        valSpan.textContent = slider.value;
    });
}

// ── Process Image ───────────────────────────────────────────────────

$('btnProcess').addEventListener('click', processImage);

async function processImage() {
    if (!currentImage) return;
    if (!cvReady) {
        statusText.textContent = 'OpenCV.js is still loading, please wait...';
        return;
    }

    showLoading('Initializing...');
    setProgress(5);

    await delay(50);

    try {
        processor = new ImageProcessor();

        // Load image
        setLoadingText('Loading image...');
        setProgress(10);
        processor.loadFromImage(sourceCanvas);
        await delay(30);

        // Preprocess
        setLoadingText('Preprocessing image...');
        setProgress(20);
        processor.preprocess({
            grayscale: $('chkGrayscale').checked,
            invert: $('chkInvert').checked,
            denoise: $('chkDenoise').checked
        });
        await delay(30);

        // Edge detection
        setLoadingText('Detecting edges (Canny)...');
        setProgress(35);
        processor.detectEdges(
            parseInt(sliders.cannyLow.value),
            parseInt(sliders.cannyHigh.value)
        );
        await delay(30);

        // Contour extraction
        setLoadingText('Extracting contours...');
        setProgress(50);
        processor.extractContours(
            parseInt(sliders.minArea.value),
            parseInt(sliders.epsilon.value)
        );
        await delay(30);

        // Hough line detection
        if ($('chkHough').checked) {
            setLoadingText('Detecting lines (Hough Transform)...');
            setProgress(60);
            processor.detectLines({
                threshold: parseInt(sliders.houghThreshold.value),
                minLineLength: parseInt(sliders.houghMinLen.value),
                maxLineGap: parseInt(sliders.houghMaxGap.value)
            });
            await delay(30);
        }

        // Circle detection
        setLoadingText('Detecting circles...');
        setProgress(70);
        processor.detectCircles();
        await delay(30);

        // OCR (optional, slow)
        if ($('chkOCR').checked) {
            setLoadingText('Running OCR text detection...');
            setProgress(75);
            await processor.detectText(sourceCanvas);
        }

        // Smart shape recognition (deduplicate + classify architectural elements)
        setLoadingText('Recognizing architectural shapes...');
        setProgress(85);
        const shapes = processor.recognizeShapes();
        await delay(30);

        setProgress(90);

        // Draw preview
        setLoadingText('Rendering preview...');
        updatePreview();
        setProgress(95);

        // Build DXF
        setLoadingText('Building DXF data...');
        const scale = parseFloat($('scaleValue').value) || 1;
        lastDXF = processor.buildDXF(scale);
        setProgress(100);

        // Stats
        const stats = lastDXF.getStats();
        statusText.textContent =
            `Done! ${stats.total} entities: ` +
            `${shapes.walls.length} walls, ` +
            `${shapes.doors.length} doors, ` +
            `${shapes.windows.length} windows, ` +
            `${shapes.rooms.length} rooms, ` +
            `${processor.lines.length} lines, ` +
            `${processor.contours.filter(c => !c._consumed).length} contours, ` +
            `${processor.circles.length} circles, ` +
            `${processor.textBlocks.length} text`;

        await delay(300);
        hideLoading();

    } catch (err) {
        hideLoading();
        statusText.textContent = `Error: ${err.message}`;
        console.error('Processing error:', err);
    }
}

// ── Preview Rendering ───────────────────────────────────────────────

function updatePreview() {
    if (!processor) return;
    processor.drawPreview(previewCanvas, {
        showEdges: $('layerEdges').checked,
        showContours: $('layerContours').checked,
        showLines: $('layerLines').checked,
        showText: $('layerText').checked,
        showWalls: $('layerWalls').checked,
        showDoors: $('layerDoors').checked,
        showWindows: $('layerWindows').checked,
        showRooms: $('layerRooms').checked
    });
}

// Layer toggle listeners
['layerEdges', 'layerContours', 'layerLines', 'layerText',
 'layerWalls', 'layerDoors', 'layerWindows', 'layerRooms'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', updatePreview);
});

// ── Export DXF ──────────────────────────────────────────────────────

$('btnExportDXF').addEventListener('click', () => {
    if (!lastDXF) {
        statusText.textContent = 'Process an image first before exporting.';
        return;
    }

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    lastDXF.download(`converted_${timestamp}.dxf`);
    statusText.textContent = 'DXF file downloaded!';
});

// ── Utility Functions ───────────────────────────────────────────────

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function showLoading(text) {
    loadingOverlay.style.display = 'flex';
    loadingText.textContent = text;
    progressBar.style.width = '0%';
}

function hideLoading() {
    loadingOverlay.style.display = 'none';
}

function setLoadingText(text) {
    loadingText.textContent = text;
}

function setProgress(pct) {
    progressBar.style.width = pct + '%';
}
