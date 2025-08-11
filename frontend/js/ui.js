// js/ui.js
import { BACKEND_URL, pingSecuencias, crearSecuencia, guardarFrame, exportarUrl, logout } from "./api.js";
import { mostrarAlertaBootstrap, showToast, inferirTipoValor, setEstado, crearBadgesEstado, pintarBadge } from "./utils.js";

document.addEventListener("DOMContentLoaded", async () => {
    // ---------- DOM ----------
    const startBtn = document.getElementById("startBtn");
    const stopBtn = document.getElementById("stopBtn");
    const downloadCsvOption = document.getElementById("downloadCsvOption");
    const downloadJsonOption = document.getElementById("downloadJsonOption");
    const etiquetaInput = document.getElementById("etiquetaGesto");
    const clearInputBtn = document.getElementById("clearInputBtn");
    const cerrarSesionBtn = document.getElementById("cerrarSesionBtn");
    const videoElement = document.getElementById("videoFrontend");

    // ---------- Ping backend (no bloqueante) ----------
    try {
        const r = await pingSecuencias();
        if (!r.ok) throw 0;
    } catch {
        mostrarAlertaBootstrap("ℹ️ No se pudo contactar al backend. Intentando en modo local.", "warning", 5000);
    }

    // iOS/Safari tweaks
    try {
        videoElement?.setAttribute("playsinline", "");
        videoElement?.setAttribute("autoplay", "");
        videoElement?.setAttribute("muted", "");
        videoElement?.removeAttribute("controls");
    } catch { }

    // ---------- Estado ----------
    let secuenciaId = null;
    let frameCounter = 0;
    let capturing = false;
    const TARGET_FPS = 10;
    const MIN_INTERVAL_MS = Math.floor(1000 / TARGET_FPS);
    let lastSentMs = 0;
    let inflight = 0;
    const MAX_INFLIGHT = 2;
    let fps = 0, lastFrameTs = performance.now(), framesThisSecond = 0;
    let latencyMs = null, netStatus = "desconocida", fpsTimer = null, pingTimer = null;

    // ---------- Badges ----------
    const { camBadge, netBadge } = videoElement ? crearBadgesEstado(videoElement) : { camBadge: null, netBadge: null };
    function actualizarIndicadoresCam() {
        let lvl = "ok";
        if (!capturing) lvl = "idle"; else if (fps < 10) lvl = "bad"; else if (fps < 20) lvl = "warn";
        camBadge && pintarBadge(camBadge, lvl);
        if (camBadge) camBadge.textContent = `📷 Cámara: ${capturing ? `${fps} FPS` : "inactiva"}`;
    }
    async function medirPing() {
        const t0 = performance.now();
        try {
            const r = await pingSecuencias();
            latencyMs = Math.round(performance.now() - t0);
            if (!r.ok) throw 0; netStatus = "ok";
        } catch { latencyMs = null; netStatus = "bad"; }
        let lvl = "idle", label = "—";
        if (capturing) {
            if (latencyMs === null || netStatus === "bad") { lvl = "bad"; label = "sin conexión"; }
            else if (latencyMs < 150) { lvl = "ok"; label = `${latencyMs} ms`; }
            else if (latencyMs < 400) { lvl = "warn"; label = `${latencyMs} ms`; }
            else { lvl = "bad"; label = `${latencyMs} ms`; }
        }
        netBadge && pintarBadge(netBadge, lvl);
        if (netBadge) netBadge.textContent = `🌐 Red: ${label}`;
    }
    function iniciarMonitores() {
        detenerMonitores();
        fpsTimer = setInterval(() => actualizarIndicadoresCam(), 2000);
        pingTimer = setInterval(() => medirPing(), 10000);
        medirPing();
    }
    function detenerMonitores() {
        if (fpsTimer) { clearInterval(fpsTimer); fpsTimer = null; }
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        fps = 0; actualizarIndicadoresCam(); medirPing();
    }

    // ---------- Backend helpers ----------
    async function crearSecuenciaSiHaceFalta() {
        if (secuenciaId) return secuenciaId;
        const entrada = (etiquetaInput?.value || "").trim();
        const { tipo, valor, nombre } = inferirTipoValor(entrada);
        if (!nombre && !valor) {
            mostrarAlertaBootstrap("⚠️ Ingresa el nombre del gesto, número (1-100), fecha (YYYY-MM-DD) o cantidad.", "warning");
            etiquetaInput?.focus();
            throw new Error("Etiqueta vacía");
        }
        const { ok, status, data } = await crearSecuencia({ nombre, tipo, valor });
        if (!ok) {
            console.error("crear_secuencia error:", status, data);
            mostrarAlertaBootstrap(`❌ Error creando secuencia (${status})`, "danger");
            throw new Error("crear_secuencia falló");
        }
        secuenciaId = data.secuencia_id;
        //showToast(`Secuencia #${secuenciaId} creada`, "success");
        return secuenciaId;
    }

    async function enviarFrame(pts) {
        if (!secuenciaId || !Array.isArray(pts) || pts.length === 0) return;
        if (inflight >= MAX_INFLIGHT) return;
        inflight++;
        try {
            await guardarFrame({ secuencia_id: secuenciaId, frame: frameCounter, landmarks: pts });
            frameCounter += 1;
        } catch (e) {
            console.error("guardar_frame err:", e);
        } finally { inflight--; }
    }

    // ---------- MediaPipe ----------
    let mpHands = null, mpCamera = null;
    function initMediaPipeIfNeeded() {
        if (mpHands) return;
        // Hands y Camera llegan desde CDN global (igual que en tu archivo original) :contentReference[oaicite:1]{index=1}
        mpHands = new Hands({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
        mpHands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.8, minTrackingConfidence: 0.7 });
        mpHands.onResults(onResultsHands);
    }
    function onResultsHands(results) {
        const now = performance.now();
        framesThisSecond++;
        if (now - lastFrameTs >= 1000) { fps = framesThisSecond; framesThisSecond = 0; lastFrameTs = now; actualizarIndicadoresCam(); }
        if (!capturing) return;
        if (now - lastSentMs < MIN_INTERVAL_MS) return;

        let pts = [];
        if (Array.isArray(results.multiHandLandmarks) && results.multiHandLandmarks.length) {
            const hand = results.multiHandLandmarks[0];
            pts = hand.map(lm => ({ x: lm.x, y: lm.y, z: lm.z }));
        }
        if (pts.length > 0) { lastSentMs = now; enviarFrame(pts); }
    }

    async function startCapture() {
        await crearSecuenciaSiHaceFalta();
        initMediaPipeIfNeeded();

        if (!navigator.mediaDevices?.getUserMedia) { mostrarAlertaBootstrap("❌ Tu navegador no soporta cámara.", "danger"); throw new Error("No getUserMedia"); }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
            if (videoElement) {
                videoElement.srcObject = stream;
                videoElement.muted = true; videoElement.playsInline = true;
                await videoElement.play().catch(() => { });
            }
        } catch (err) { console.error("❌ Error cámara:", err); mostrarAlertaBootstrap("❌ Error al acceder a la cámara", "danger"); throw err; }

        mpCamera = new Camera(videoElement, { onFrame: async () => { try { await mpHands.send({ image: videoElement }); } catch (e) { console.error("❌ onFrame:", e); } }, width: 640, height: 480 });

        frameCounter = 0; lastSentMs = 0; inflight = 0; capturing = true;
        await mpCamera.start();
        setEstado("🟢 Capturando…"); mostrarAlertaBootstrap("🟢 Captura iniciada", "success");
        iniciarMonitores();
    }

    function stopCapture() {
        capturing = false;
        try { mpCamera?.stop(); } catch { }
        try {
            const s = videoElement?.srcObject;
            s?.getTracks?.().forEach(t => t.stop());
            if (videoElement) videoElement.srcObject = null;
        } catch { }
        setEstado("🔴 Detenido", true);
        mostrarAlertaBootstrap("⛔ Captura detenida", "danger");
        detenerMonitores();
    }

    // ---------- Descargas ----------
    function descargarCSV() {
        const url = exportarUrl({ formato: "csv", secuencia_id: secuenciaId ?? undefined });
        window.open(url, "_blank");
    }
    function descargarJSON() {
        const url = exportarUrl({ formato: "json", secuencia_id: secuenciaId ?? undefined });
        window.open(url, "_blank");
    }

    // ---------- Listeners (botones respetando tus IDs) ----------
    clearInputBtn?.addEventListener("click", () => { if (etiquetaInput) { etiquetaInput.value = ""; etiquetaInput.focus(); } });
    startBtn?.addEventListener("click", async () => { try { if (capturing) return; await startCapture(); } catch { setEstado("🔴 Esperando…", true); } });
    stopBtn?.addEventListener("click", () => { if (!capturing) return; stopCapture(); });
    downloadCsvOption?.addEventListener("click", (e) => { e.preventDefault(); descargarCSV(); });
    downloadJsonOption?.addEventListener("click", (e) => { e.preventDefault(); descargarJSON(); });
    cerrarSesionBtn?.addEventListener("click", () => { logout().finally(() => { window.location.href = "/login"; }); });

    // ---------- Globales (respetando tus funciones) ----------
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
});
