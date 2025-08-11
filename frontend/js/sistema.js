function mostrarAlertaBootstrap(mensaje, tipo = 'info', duracion = 4000) {
    const contenedor = document.getElementById('toastContainer');
    if (!contenedor) return alert(mensaje);
    const id = `toast-${Date.now()}`;
    const toast = document.createElement('div');
    toast.className = `toast align-items-center text-bg-${tipo} border-0 shadow`;
    toast.id = id;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    toast.setAttribute('aria-atomic', 'true');
    toast.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${mensaje}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto"
        data-bs-dismiss="toast" aria-label="Cerrar"></button>
    </div>`;
    contenedor.appendChild(toast);
    const bsToast = new bootstrap.Toast(toast, { delay: duracion });
    bsToast.show();
    toast.addEventListener('hidden.bs.toast', () => toast.remove());
}
const showToast = (msg, variant = "primary") =>
    mostrarAlertaBootstrap(msg, { primary: 'primary', success: 'success', warning: 'warning', danger: 'danger', secondary: 'secondary' }[variant] || 'primary');

// ---------- Arranque (no bloquea si el ping falla) ----------
document.addEventListener('DOMContentLoaded', async () => {
    window.BACKEND_URL = (window.BACKEND_URL && String(window.BACKEND_URL).trim())
        ? String(window.BACKEND_URL).trim()
        : "https://lse-backend-479238723367.us-central1.run.app";

    const ua = navigator.userAgent || "";
    const isIOS = /iP(ad|hone|od)/.test(ua);
    const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
    const isIOSSafari = isIOS && isSafari;

    try {
        const r = await fetch(`${BACKEND_URL}/api/secuencias`, { credentials: "include", cache: 'no-store' });
        if (!r.ok) throw 0;
    } catch {
        mostrarAlertaBootstrap("ℹ️ No se pudo contactar al backend. Intentando en modo local.", "warning", 5000);
    }

    inicializarEventos(BACKEND_URL, { isIOSSafari });
});

function inicializarEventos(BACKEND_URL, { isIOSSafari }) {
    // ---------- DOM ----------
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const downloadCsvOption = document.getElementById('downloadCsvOption');
    const downloadJsonOption = document.getElementById('downloadJsonOption');
    const etiquetaInput = document.getElementById('etiquetaGesto');
    const estadoReconocimiento = document.getElementById('estadoReconocimiento');
    const clearInputBtn = document.getElementById('clearInputBtn');
    const cerrarSesionBtn = document.getElementById('cerrarSesionBtn');
    const videoElement = document.getElementById('videoFrontend');

    if (!videoElement) { console.error("No se encontró #videoFrontend"); return; }

    // iOS/Safari
    try {
        videoElement.setAttribute('playsinline', '');
        videoElement.setAttribute('autoplay', '');
        videoElement.setAttribute('muted', '');
        videoElement.removeAttribute('controls');
    } catch { }

    // ---------- Estado ----------
    let secuenciaId = null;
    let frameCounter = 0;
    let capturing = false;

    // Fluidez: limitador de envío
    const TARGET_FPS = 10;                      
    const MIN_INTERVAL_MS = Math.floor(1000 / TARGET_FPS);
    let lastSentMs = 0;

    // Backpressure: máximo de solicitudes en vuelo
    let inflight = 0;
    const MAX_INFLIGHT = 2;                      

    // FPS y ping
    let fps = 0, lastFrameTs = performance.now(), framesThisSecond = 0;
    let latencyMs = null, netStatus = 'desconocida', fpsTimer = null, pingTimer = null;

    // ---------- Barra de estado ----------
    const statusBar = document.createElement('div');
    statusBar.style.maxWidth = '640px';
    statusBar.style.margin = '8px auto 0';
    statusBar.style.display = 'grid';
    statusBar.style.gridTemplateColumns = '1fr 1fr';
    statusBar.style.gap = '8px';
    const badgeBase = `
    display:inline-block;padding:6px 10px;border-radius:999px;font-weight:700;
    text-align:center;box-shadow:0 6px 16px rgba(0,0,0,0.12);background:#fff;`;

    const camBadge = document.createElement('div'); camBadge.style.cssText = badgeBase; camBadge.textContent = '📷 Cámara: —';
    const netBadge = document.createElement('div'); netBadge.style.cssText = badgeBase; netBadge.textContent = '🌐 Red: —';
    videoElement.parentElement?.insertAdjacentElement('afterend', statusBar);
    statusBar.appendChild(camBadge); statusBar.appendChild(netBadge);

    const setBadgeColor = (el, lvl) => {
        const m = {
            ok: { bg: '#e8f5e9', fg: '#1b5e20' }, warn: { bg: '#fff8e1', fg: '#ff6f00' },
            bad: { bg: '#ffebee', fg: '#b71c1c' }, idle: { bg: '#eef2f7', fg: '#37474f' }
        }[lvl] || { bg: '#eef2f7', fg: '#37474f' };
        el.style.background = m.bg; el.style.color = m.fg;
    };
    function actualizarIndicadoresCam() {
        let lvl = 'ok'; if (!capturing) lvl = 'idle'; else if (fps < 10) lvl = 'bad'; else if (fps < 20) lvl = 'warn';
        setBadgeColor(camBadge, lvl); camBadge.textContent = `📷 Cámara: ${capturing ? `${fps} FPS` : 'inactiva'}`;
    }
    function actualizarIndicadoresNet() {
        let lvl = 'idle', label = '—';
        if (capturing) {
            if (latencyMs === null || netStatus === 'bad') { lvl = 'bad'; label = 'sin conexión'; }
            else if (latencyMs < 150) { lvl = 'ok'; label = `${latencyMs} ms`; }
            else if (latencyMs < 400) { lvl = 'warn'; label = `${latencyMs} ms`; }
            else { lvl = 'bad'; label = `${latencyMs} ms`; }
        }
        setBadgeColor(netBadge, lvl); netBadge.textContent = `🌐 Red: ${label}`;
    }
    async function medirPing() {
        const t0 = performance.now();
        try {
            const r = await fetch(`${BACKEND_URL}/api/secuencias`, { credentials: "include", cache: "no-store" });
            latencyMs = Math.round(performance.now() - t0);
            if (!r.ok) throw 0; netStatus = 'ok';
        } catch { latencyMs = null; netStatus = 'bad'; }
        actualizarIndicadoresNet();
    }
    function iniciarMonitores() {
        detenerMonitores(); fpsTimer = setInterval(() => actualizarIndicadoresCam(), 2000);
        pingTimer = setInterval(() => medirPing(), 10000); medirPing();
    }
    function detenerMonitores() {
        if (fpsTimer) { clearInterval(fpsTimer); fpsTimer = null; }
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } fps = 0; actualizarIndicadoresCam(); actualizarIndicadoresNet();
    }

    function setEstado(txt, danger = false) {
        if (!estadoReconocimiento) return;
        estadoReconocimiento.textContent = txt;
        estadoReconocimiento.classList.toggle('text-danger', danger);
        estadoReconocimiento.classList.toggle('text-success', !danger);
    }

    // ---------- Backend ----------
    async function crearSecuenciaSiHaceFalta() {
        if (secuenciaId) return secuenciaId;
        const nombre = (etiquetaInput?.value || "").trim();
        if (!nombre) { mostrarAlertaBootstrap("⚠️ Ingresa el nombre del gesto", "warning"); etiquetaInput?.focus(); throw new Error("Etiqueta vacía"); }
        const res = await fetch(`${BACKEND_URL}/api/crear_secuencia`, {
            method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ nombre })
        });
        const txt = await res.text(); let data = null; try { data = JSON.parse(txt); } catch { }
        if (!res.ok || !data?.ok) {
            console.error("crear_secuencia error:", res.status, txt);
            mostrarAlertaBootstrap(`❌ Error creando secuencia (${res.status})`, "danger"); throw new Error("crear_secuencia falló");
        }
        secuenciaId = data.secuencia_id; mostrarAlertaBootstrap(`🧠 Secuencia #${secuenciaId} creada`, "success"); return secuenciaId;
    }

    async function enviarFrame(landmarks) {
        if (!secuenciaId || !Array.isArray(landmarks) || landmarks.length === 0) return;
        if (inflight >= MAX_INFLIGHT) return; 
        inflight++;
        try {
            await fetch(`${BACKEND_URL}/api/guardar_frame`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ secuencia_id: secuenciaId, frame: frameCounter, landmarks })
            });
            frameCounter += 1;
        } catch (err) {
            console.error("Fallo al enviar frame:", err);
        } finally {
            inflight--;
        }
    }

    // ---------- MediaPipe ----------
    let mpHands = null, mpCamera = null;
    function initMediaPipeIfNeeded() {
        if (mpHands) return;
        mpHands = new Hands({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
        mpHands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.8, minTrackingConfidence: 0.7 });
        mpHands.onResults(onResultsHands);
    }
    function onResultsHands(results) {
        const now = performance.now();
        framesThisSecond++; if (now - lastFrameTs >= 1000) { fps = framesThisSecond; framesThisSecond = 0; lastFrameTs = now; actualizarIndicadoresCam(); }
        if (!capturing) return;

        // Rate limit
        if (now - lastSentMs < MIN_INTERVAL_MS) return;

        let pts = [];
        if (Array.isArray(results.multiHandLandmarks) && results.multiHandLandmarks.length) {
            const hand = results.multiHandLandmarks[0];
            pts = hand.map(lm => ({ x: lm.x, y: lm.y, z: lm.z }));
        }

        // Solo enviamos si hay mano detectada
        if (pts.length > 0) {
            lastSentMs = now;
            enviarFrame(pts);
        }
    }

    async function startCapture() {
        await crearSecuenciaSiHaceFalta();
        initMediaPipeIfNeeded();

        if (!navigator.mediaDevices?.getUserMedia) {
            mostrarAlertaBootstrap("❌ Tu navegador no soporta captura de cámara.", "danger"); throw new Error("No getUserMedia");
        }
        if (isIOSSafari) { mostrarAlertaBootstrap("ℹ️ Safari iOS podría requerir tocar 'Iniciar' otra vez si no ves video.", "primary", 6000); }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
            videoElement.srcObject = stream; videoElement.muted = true; videoElement.playsInline = true;
            await videoElement.play().catch(() => { });
        } catch (err) { console.error("❌ Error cámara:", err); mostrarAlertaBootstrap("❌ Error al acceder a la cámara", "danger"); throw err; }

        mpCamera = new Camera(videoElement, { onFrame: async () => { try { await mpHands.send({ image: videoElement }); } catch (e) { console.error("❌ onFrame:", e); } }, width: 640, height: 480 });

        frameCounter = 0; lastSentMs = 0; inflight = 0; capturing = true;
        await mpCamera.start();
        setEstado("🟢 Capturando…"); mostrarAlertaBootstrap("🟢 Captura iniciada", "success");
        iniciarMonitores(); actualizarIndicadoresCam(); actualizarIndicadoresNet();
    }

    function stopCapture() {
        capturing = false;
        try { mpCamera?.stop(); } catch { }
        try {
            const s = videoElement?.srcObject;
            s?.getTracks?.().forEach(t => t.stop());
            videoElement.srcObject = null;
        } catch { }
        setEstado("🔴 Detenido", true); mostrarAlertaBootstrap("⛔ Captura detenida", "danger"); detenerMonitores();
    }

    // ---------- Descargas ----------
    function descargarCSV() {
        const base = `${BACKEND_URL}/api/exportar?formato=csv`;
        const url = secuenciaId ? `${base}&secuencia_id=${secuenciaId}` : base;
        window.open(url, '_blank'); 
    }
    function descargarJSON() {
        const base = `${BACKEND_URL}/api/exportar?formato=json`;
        const url = secuenciaId ? `${base}&secuencia_id=${secuenciaId}` : base;
        window.open(url, '_blank');
    }

    // ---------- Listeners ----------
    clearInputBtn?.addEventListener('click', () => {
        if (etiquetaInput) { etiquetaInput.value = ''; etiquetaInput.focus(); }
        //mostrarAlertaBootstrap("🧼 Campo limpiado", "secondary");
    });

    startBtn?.addEventListener('click', async () => {
        try { if (capturing) return; await startCapture(); } catch { setEstado("🔴 Esperando…", true); }
    });

    stopBtn?.addEventListener('click', () => { if (!capturing) return; stopCapture(); });

    downloadCsvOption?.addEventListener('click', (e) => { e.preventDefault(); descargarCSV(); });
    downloadJsonOption?.addEventListener('click', (e) => { e.preventDefault(); descargarJSON(); });

    cerrarSesionBtn?.addEventListener("click", () => {
        fetch(`${BACKEND_URL}/logout`, { credentials: "include" }).finally(() => { window.location.href = "/login"; });
    });

    // ---------- Globales para onclick del HTML ----------
    window.capturarSecuencia = () => {
        etiquetaInput?.focus();
        startBtn?.scrollIntoView({ behavior: "smooth", block: "center" });
        mostrarAlertaBootstrap("🎥 Listo para capturar. Presiona 'Iniciar'.", "success");
    };
    window.subirVideo = () => { mostrarAlertaBootstrap("⚠️ Subir video: funcionalidad pendiente.", "warning"); };
    window.verHistorial = () => {
        const iframe = document.getElementById("iframeHistorial");
        if (iframe) iframe.src = "historial.html?v=" + Date.now();
        const modalEl = document.getElementById("modalHistorial");
        if (modalEl) new bootstrap.Modal(modalEl).show();
    };

    setEstado("🔴 Esperando…", true);
}
