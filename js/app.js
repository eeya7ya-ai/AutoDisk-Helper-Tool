/**
 * App Controller - Wires together UI, ImageProcessor, and DXFWriter
 */

let cvReady = false;
let processor = null;
let currentImage = null;
let lastDXF = null;

// ── Error Handling ─────────────────────────────────────────────────

function showErrorBanner(title, message) {
    const banner = document.getElementById('errorBanner');
    const titleEl = document.getElementById('errorTitle');
    const msgEl = document.getElementById('errorMessage');
    if (banner && titleEl && msgEl) {
        titleEl.textContent = title;
        msgEl.textContent = message;
        banner.style.display = 'block';
    }
}

function hideErrorBanner() {
    const banner = document.getElementById('errorBanner');
    if (banner) banner.style.display = 'none';
}

// ── OpenCV Ready ────────────────────────────────────────────────────

function onOpenCVReady() {
    cvReady = true;
    console.log('OpenCV.js is ready');
    const indicator = document.getElementById('cvStatus');
    if (indicator) {
        indicator.textContent = 'OpenCV: Ready';
        indicator.classList.add('ready');
    }
    hideErrorBanner();
}

// Called when the OpenCV <script> tag fails to load (onerror)
window.onOpenCVLoadError = function () {
    console.error('OpenCV.js script failed to load from CDN');
    const indicator = document.getElementById('cvStatus');
    if (indicator) {
        indicator.textContent = 'OpenCV: Failed to load';
        indicator.classList.add('error');
    }
    showErrorBanner(
        'OpenCV.js failed to load',
        'The computer vision library could not be loaded. Please check your internet connection and reload the page. ' +
        'If you downloaded this tool for offline use, you need an internet connection for the first load.'
    );
};

// If the script already failed before app.js loaded, handle it now
if (window._opencvLoadError) {
    window.onOpenCVLoadError();
}

// Detect OpenCV readiness via onRuntimeInitialized (WASM init complete)
function waitForOpenCV() {
    // If the script already failed to load, don't bother polling
    if (window._opencvLoadError) return;

    try {
        if (typeof cv !== 'undefined' && cv.Mat) {
            // Already initialized
            onOpenCVReady();
        } else if (typeof cv !== 'undefined' && cv.onRuntimeInitialized !== undefined) {
            // Script loaded but WASM not ready yet
            cv.onRuntimeInitialized = onOpenCVReady;
        } else {
            // Script not loaded yet, poll briefly
            const start = Date.now();
            const check = setInterval(() => {
                // Stop polling if script load error occurred
                if (window._opencvLoadError) {
                    clearInterval(check);
                    return;
                }
                if (typeof cv !== 'undefined') {
                    clearInterval(check);
                    if (cv.Mat) {
                        onOpenCVReady();
                    } else {
                        cv.onRuntimeInitialized = onOpenCVReady;
                    }
                } else if (Date.now() - start > 30000) {
                    clearInterval(check);
                    console.error('OpenCV.js failed to load within 30s');
                    const indicator = document.getElementById('cvStatus');
                    if (indicator) {
                        indicator.textContent = 'OpenCV: Failed to load';
                        indicator.classList.add('error');
                    }
                    showErrorBanner(
                        'OpenCV.js timed out',
                        'The computer vision library took too long to load. Please check your internet connection and reload the page.'
                    );
                }
            }, 200);
        }
    } catch (err) {
        console.error('Error during OpenCV initialization:', err);
        const indicator = document.getElementById('cvStatus');
        if (indicator) {
            indicator.textContent = 'OpenCV: Error';
            indicator.classList.add('error');
        }
        showErrorBanner(
            'OpenCV.js initialization error',
            'An error occurred while initializing the computer vision library: ' + err.message
        );
    }
}

// Start waiting for OpenCV as soon as app.js loads
waitForOpenCV();

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
        img.onerror = () => {
            statusText.textContent = 'Error: Could not load the selected image file.';
        };
        img.src = e.target.result;
    };
    reader.onerror = () => {
        statusText.textContent = 'Error: Could not read the selected file.';
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
        if (window._opencvLoadError) {
            statusText.textContent = 'OpenCV.js failed to load. Please check your internet connection and reload.';
        } else {
            statusText.textContent = 'OpenCV.js is still loading, please wait...';
        }
        return;
    }

    showLoading('Initializing...');
    setProgress(5);

    // Small delay to let the UI update
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
            if (typeof Tesseract === 'undefined') {
                console.warn('Tesseract.js not loaded - skipping OCR');
                statusText.textContent = 'Warning: OCR library not available (no internet?)';
            } else {
                setLoadingText('Running OCR text detection...');
                setProgress(75);
                await processor.detectText(sourceCanvas);
            }
        }
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
            `${processor.lines.length} lines, ` +
            `${processor.contours.length} contours, ` +
            `${processor.circles.length} circles, ` +
            `${processor.textBlocks.length} text blocks`;

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
        showText: $('layerText').checked
    });
}

// Layer toggle listeners
['layerEdges', 'layerContours', 'layerLines', 'layerText'].forEach(id => {
    $(id).addEventListener('change', updatePreview);
});

// ── Export DXF ──────────────────────────────────────────────────────

$('btnExportDXF').addEventListener('click', () => {
    if (!lastDXF) {
        statusText.textContent = 'Process an image first before exporting.';
        return;
    }

    try {
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
        lastDXF.download(`converted_${timestamp}.dxf`);
        statusText.textContent = 'DXF file downloaded!';
    } catch (err) {
        statusText.textContent = `Export error: ${err.message}`;
        console.error('Export error:', err);
    }
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

// ── Global Error Handler ────────────────────────────────────────────

window.addEventListener('error', (event) => {
    // Catch unhandled errors from WASM or script initialization
    if (event.message && event.message.includes('RuntimeError')) {
        console.error('WASM Runtime Error:', event.message);
        showErrorBanner(
            'Runtime Error',
            'The application encountered an error during initialization. Please reload the page and try again.'
        );
    }
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
});
