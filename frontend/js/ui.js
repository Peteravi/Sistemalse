// js/ui.js
import { crearSecuencia, guardarFrame, exportarUrl, logout } from "./api.js";
import { mostrarAlertaBootstrap, showToast, inferirTipoValor, setEstado } from "./utils.js";

document.addEventListener("DOMContentLoaded", () => {
    // ------- DOM -------
    const $ = (id) => document.getElementById(id);
    const startBtn = $("startBtn"), stopBtn = $("stopBtn");
    const btnFS = $("btnPantallaCompleta"), iconFS = $("iconFullscreen");
    const etiquetaInput = $("etiquetaGesto"), clearInputBtn = $("clearInputBtn"), cerrarSesionBtn = $("cerrarSesionBtn");
    const dCsv = $("downloadCsvOption"), dJson = $("downloadJsonOption");
    const video = $("videoFrontend"), overlay = $("overlay");
    const captureWrapper = $("captureWrapper"), captureStage = $("captureStage");
    const indicadorResolucion = $("indicadorResolucion"), indicadorGrabando = $("indicadorGrabando");

    // Botón Cambiar cámara si no existe (compatibilidad con tu HTML/CSS)
    let btnCam = $("btnCambiarCamara");
    if (!btnCam) {
        const controls = captureStage?.querySelector(".capture-controls");
        if (controls) {
            btnCam = document.createElement("button");
            btnCam.id = "btnCambiarCamara";
            btnCam.type = "button";
            btnCam.className = "btn btn-outline-secondary btn-sm rounded-pill px-3 ms-2";
            btnCam.innerHTML = '<i class="bi bi-camera-reverse me-1"></i> Cambiar cámara';
            controls.appendChild(btnCam);
        }
    }

    // Asegurar clicabilidad en fullscreen
    try {
        if (overlay) overlay.style.pointerEvents = "none";
        const controlsEl = captureStage?.querySelector(".capture-controls");
        if (controlsEl) controlsEl.style.zIndex = "5";
    } catch { }

    // ------- Estado -------
    let secuenciaId = null, frameCounter = 0, inflight = 0, capturing = false;
    const TARGET_FPS = 10, MIN_INTERVAL_MS = Math.floor(1000 / TARGET_FPS);
    let lastSentMs = 0;

    // ------- Fullscreen -------
    const isFS = () =>
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.msFullscreenElement;

    let fsFallback = false;

    const restoreFromFS = () => {
        try {
            captureStage?.style.removeProperty("height");
            captureStage?.style.removeProperty("width");
            overlay?.style.removeProperty("width");
            overlay?.style.removeProperty("height");
            const controlsEl = captureStage?.querySelector(".capture-controls");
            if (controlsEl) controlsEl.style.bottom = ".65rem";
            updateStage(); setTimeout(updateStage, 80); requestAnimationFrame(updateStage);
        } catch { }
    };

    const fsUI = () => {
        const active = !!isFS() || fsFallback;
        captureWrapper?.classList.toggle("is-fullscreen", active);
        btnFS?.setAttribute("aria-pressed", String(active));
        iconFS?.classList.toggle("bi-arrows-fullscreen", !active);
        iconFS?.classList.toggle("bi-fullscreen-exit", active);

        // Safe area en móviles
        const controlsEl = captureStage?.querySelector(".capture-controls");
        if (controlsEl) {
            controlsEl.style.bottom = active
                ? `max(.65rem, env(safe-area-inset-bottom, .65rem))`
                : ".65rem";
        }

        if (!active) {
            try { screen.orientation?.unlock?.(); } catch { }
            restoreFromFS();
            // al salir de FS en móvil, recentrar
            ensureCaptureVisible();
            setTimeout(ensureCaptureVisible, 120);
        } else {
            updateStage();
            setTimeout(updateStage, 120);
            setTimeout(updateStage, 300);
        }
    };

    async function enterFSPrefer() {
        try { return await (captureStage.requestFullscreen?.() || captureStage.webkitRequestFullscreen?.() || captureStage.msRequestFullscreen?.() || Promise.reject()); }
        catch { }
        try { return await (video.requestFullscreen?.() || video.webkitRequestFullscreen?.() || video.msRequestFullscreen?.() || Promise.reject()); }
        catch { }
        try { return await (captureWrapper.requestFullscreen?.() || captureWrapper.webkitRequestFullscreen?.() || captureWrapper.msRequestFullscreen?.() || Promise.reject()); }
        catch { throw new Error("no-fs"); }
    }

    const toggleFS = async () => {
        try {
            if (!isFS() && !fsFallback) {
                try { await enterFSPrefer(); }
                catch { fsFallback = true; captureWrapper.classList.add("is-fullscreen"); }
                try { await screen.orientation?.lock?.("landscape"); } catch { }
            } else {
                try { await (document.exitFullscreen?.() || document.webkitExitFullscreen?.() || document.msExitFullscreen?.()); } catch { }
                fsFallback = false; captureWrapper.classList.remove("is-fullscreen");
            }
        } finally { fsUI(); }
    };

    btnFS?.addEventListener("click", toggleFS);
    ["fullscreenchange", "webkitfullscreenchange", "msfullscreenchange"].forEach(e => document.addEventListener(e, fsUI));
    captureStage?.addEventListener("dblclick", () => btnFS?.click());
    let tTap = 0;
    captureStage?.addEventListener("touchend", () => { const n = Date.now(); if (n - tTap < 300) btnFS?.click(); tTap = n; });
    document.addEventListener("keydown", (e) => { if (e.key.toLowerCase() === "f") btnFS?.click(); });

    // ------- Cámara Manager (solo getUserMedia) -------
    const LS = { facing: "lse_facing", devUser: "lse_dev_user", devEnv: "lse_dev_env" };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

    const Cam = {
        stream: null, switching: false, devices: [],
        facing: localStorage.getItem(LS.facing) || "user",
        deviceIdUser: localStorage.getItem(LS.devUser) || null,
        deviceIdEnv: localStorage.getItem(LS.devEnv) || null,

        async ensureDevices() {
            try {
                let granted = false;
                try { const p = await navigator.permissions?.query?.({ name: "camera" }); granted = p?.state === "granted"; } catch { }
                if (!this.devices.length && !this.stream && !granted) {
                    const t = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    t.getTracks().forEach(tr => tr.stop()); await sleep(80);
                }
            } catch { }
            this.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
            return this.devices;
        },

        pickByLabel(facing) {
            if (!this.devices.length) return null;
            const reF = /(front|frontal|user|delantera|selfie)/i, reB = /(back|rear|environment|trasera|principal|wide)/i;
            let best = null;
            for (const d of this.devices) {
                const L = d.label || "";
                if (facing === "user" && reF.test(L)) best = d;
                if (facing === "environment" && reB.test(L)) best = d;
            }
            if (!best) best = facing === "user" ? this.devices[0] : this.devices[this.devices.length - 1];
            return best?.deviceId || null;
        },

        async shutdown() {
            try {
                this.stream?.getTracks?.().forEach(t => t.stop());
                if (video) { try { video.pause(); } catch { } video.srcObject = null; }
            } catch { }
            await sleep(isIOS ? 350 : 250);
        },

        async openStream(targetFacing) {
            await this.ensureDevices();
            const known = targetFacing === "user" ? this.deviceIdUser : this.deviceIdEnv;
            if (known) {
                try {
                    return await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: known } } });
                } catch { }
            }
            try { return await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { exact: targetFacing } } }); } catch { }
            try { return await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: targetFacing } } }); } catch { }
            const wanted = this.pickByLabel(targetFacing);
            return await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: wanted } } });
        },

        async start(facing = this.facing) {
            if (this.switching) return;
            this.switching = true;
            try {
                await this.shutdown();
                const stream = await this.openStream(facing);
                this.stream = stream;

                video.srcObject = stream; video.muted = true; video.playsInline = true;
                await video.play().catch(() => { });

                updateStage();

                // Mapear deviceId por facing real
                const tr = stream.getVideoTracks?.()[0];
                const settings = tr?.getSettings?.() || {};
                const fm = (settings.facingMode || "").toLowerCase();
                const did = settings.deviceId || null;
                const label = (tr?.label || "").toLowerCase();
                const realFacing = fm || (/(back|rear|environment|trasera|principal|wide)/i.test(label) ? "environment" : "user");

                if (realFacing === "user") {
                    this.deviceIdUser = did || this.deviceIdUser || this.pickByLabel("user");
                    localStorage.setItem(LS.devUser, this.deviceIdUser || "");
                } else {
                    this.deviceIdEnv = did || this.deviceIdEnv || this.pickByLabel("environment");
                    localStorage.setItem(LS.devEnv, this.deviceIdEnv || "");
                }

                if (realFacing !== facing) {
                    const correctId = facing === "user" ? this.deviceIdUser : this.deviceIdEnv;
                    if (correctId && (!did || correctId !== did)) {
                        await this.shutdown();
                        const s2 = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: correctId } } });
                        this.stream = s2; video.srcObject = s2; await video.play().catch(() => { });
                    }
                }

                this.facing = facing; localStorage.setItem(LS.facing, this.facing);
            } catch (e) {
                if (e?.name === "NotReadableError") {
                    mostrarAlertaBootstrap("❌ Cámara ocupada por otra app (WhatsApp/Cámara/Meet). Ciérrala y reintenta.", "danger", 7000);
                } else if (e?.name === "NotAllowedError") {
                    mostrarAlertaBootstrap("🚫 Permiso de cámara denegado. Habilítalo en Ajustes del sitio.", "danger", 7000);
                } else if (e?.name === "NotFoundError") {
                    mostrarAlertaBootstrap("📷 No se encontró cámara en el dispositivo.", "danger", 5000);
                } else {
                    mostrarAlertaBootstrap("❌ No se pudo iniciar la cámara.", "danger", 5000);
                }
                throw e;
            } finally {
                this.switching = false;
            }
        }
    };

    // ------- MediaPipe (sin window.Camera) -------
    let mpHands = null;
    let rafId = null;
    let sending = false;

    function initMP() {
        if (mpHands) return;
        mpHands = new Hands({
            locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
        });
        mpHands.setOptions({
            maxNumHands: 1,
            modelComplexity: 1,
            minDetectionConfidence: 0.8,
            minTrackingConfidence: 0.7,
        });
        mpHands.onResults(onResults);
    }

    function onResults(res) {
        if (!capturing) return;
        const now = performance.now();
        if (now - lastSentMs < MIN_INTERVAL_MS) return;
        const pts = (res.multiHandLandmarks?.[0] || []).map(lm => ({ x: lm.x, y: lm.y, z: lm.z }));
        if (pts.length) { lastSentMs = now; sendFrame(pts); }
    }

    // Bucle de procesamiento a ~TARGET_FPS sin solapar envíos
    function startLoop() {
        if (rafId) return;
        const loop = () => {
            if (!capturing || !video?.videoWidth) {
                rafId = requestAnimationFrame(loop);
                return;
            }
            const now = performance.now();
            if (!sending && now - lastSentMs >= MIN_INTERVAL_MS) {
                sending = true;
                mpHands.send({ image: video })
                    .catch(console.error)
                    .finally(() => { sending = false; });
            }
            rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);
    }

    function stopLoop() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        sending = false;
    }

    // ------- Backend -------
    async function ensureSecuencia() {
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
            mostrarAlertaBootstrap(`❌ Error creando secuencia (${status})`, "danger");
            throw new Error("crear_secuencia");
        }
        secuenciaId = data.secuencia_id; return secuenciaId;
    }

    async function sendFrame(pts) {
        if (!secuenciaId || inflight >= 2) return;
        inflight++;
        try {
            await guardarFrame({ secuencia_id: secuenciaId, frame: frameCounter, landmarks: pts });
            frameCounter++;
        } catch (e) {
            console.error("guardar_frame", e);
        } finally {
            inflight--;
        }
    }

    // ------- Stage / HUD -------
    function updateStage() {
        if (!captureStage) return;
        if (overlay) {
            overlay.width = captureStage.clientWidth;
            overlay.height = captureStage.clientHeight;
        }
        const w = video?.videoWidth || captureStage.clientWidth || 0;
        const h = video?.videoHeight || captureStage.clientHeight || 0;
        if (indicadorResolucion) indicadorResolucion.textContent = `${w}×${h}`;
    }

    // Centrar el capturador en landscape cuando NO hay fullscreen
    function ensureCaptureVisible() {
        const activeFS = !!isFS() || fsFallback;
        const isLandscape = window.matchMedia("(orientation: landscape)").matches;
        if (!captureWrapper || activeFS || !isLandscape) return;
        const rect = captureWrapper.getBoundingClientRect();
        if (rect.top > 16 || rect.top < -16) {
            const y = rect.top + window.pageYOffset - 12;
            window.scrollTo({ top: y, behavior: "smooth" });
        }
    }

    video?.addEventListener("loadedmetadata", () => { updateStage(); ensureCaptureVisible(); });
    window.addEventListener("resize", () => { updateStage(); ensureCaptureVisible(); });
    if (window.visualViewport) window.visualViewport.addEventListener("resize", () => setTimeout(() => { updateStage(); ensureCaptureVisible(); }, 60));
    window.addEventListener("orientationchange", () => {
        setTimeout(() => { updateStage(); ensureCaptureVisible(); }, 180);
        setTimeout(ensureCaptureVisible, 600); // por la animación de la barra del navegador
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) setTimeout(() => { updateStage(); ensureCaptureVisible(); }, 100); });

    // ------- Acciones -------
    async function startCapture() {
        await ensureSecuencia(); initMP();
        await Cam.start(Cam.facing);
        frameCounter = 0; lastSentMs = 0; capturing = true;
        startLoop();
        setEstado("🟢 Capturando…"); indicadorGrabando?.classList?.remove("d-none");
        mostrarAlertaBootstrap("🟢 Captura iniciada", "success");
        ensureCaptureVisible();
    }

    function stopCapture() {
        capturing = false; stopLoop(); Cam.shutdown();
        setEstado("🔴 Detenido", true); indicadorGrabando?.classList?.add("d-none");
        mostrarAlertaBootstrap("⛔ Captura detenida", "danger");
    }

    async function switchCamera() {
        await Cam.ensureDevices();
        if (Cam.devices.length <= 1) return mostrarAlertaBootstrap("ℹ️ Solo hay una cámara disponible.", "warning");
        const target = Cam.facing === "user" ? "environment" : "user";
        mostrarAlertaBootstrap(`🔄 Cambiando a cámara ${target === "user" ? "frontal" : "trasera"}…`, "info");
        try {
            await Cam.start(target);
            setEstado(capturing ? `🟢 Capturando (${target === "user" ? "frontal" : "trasera"})…` : `👀 Vista previa (${target === "user" ? "frontal" : "trasera"}) lista`);
            showToast("✅ Cámara cambiada", "success");
            ensureCaptureVisible();
        } catch (e) {
            if (e?.name === "NotReadableError") mostrarAlertaBootstrap("❌ Cámara ocupada por otra app (WhatsApp/Cámara/Meet). Ciérrala y reintenta.", "danger", 7000);
            else mostrarAlertaBootstrap("❌ No se pudo cambiar la cámara", "danger");
        }
    }

    // ------- Listeners -------
    clearInputBtn?.addEventListener("click", () => { etiquetaInput.value = ""; etiquetaInput.focus(); });
    startBtn?.addEventListener("click", async () => { if (capturing || Cam.switching) return; try { await startCapture(); } catch { setEstado("🔴 Esperando…", true); } });
    stopBtn?.addEventListener("click", () => { if (!capturing || Cam.switching) return; stopCapture(); });
    btnCam?.addEventListener("click", async () => { if (Cam.switching) return; await switchCamera(); });

    dCsv?.addEventListener("click", (e) => { e.preventDefault(); window.open(exportarUrl({ formato: "csv", secuencia_id: secuenciaId || undefined }), "_blank"); });
    dJson?.addEventListener("click", (e) => { e.preventDefault(); window.open(exportarUrl({ formato: "json", secuencia_id: secuenciaId || undefined }), "_blank"); });
    cerrarSesionBtn?.addEventListener("click", () => { logout().finally(() => location.href = "/login"); });

    // ------- Inicial -------
    try { video?.setAttribute("playsinline", ""); video?.setAttribute("autoplay", ""); video?.setAttribute("muted", ""); video?.removeAttribute("controls"); } catch { }
    setEstado("🔴 Esperando…", true);
    indicadorGrabando?.classList?.add("d-none");
    updateStage(); fsUI(); ensureCaptureVisible();

    // ====== BOTONES SUPERIORES (expuestos a window) ======
    // 1) Capturar Secuencia -> solo permisos + vista previa (NO graba)
    window.capturarSecuencia = async () => {
        try {
            await Cam.start(Cam.facing); // pide permiso y arranca preview
            setEstado("👀 Vista previa lista. Pulsa «Iniciar» para grabar.");
            mostrarAlertaBootstrap("📸 Permiso de cámara concedido. Vista previa activa.", "success");
            ensureCaptureVisible();
        } catch (e) {
            // errores típicos ya se notifican en Cam.start
        }
    };

    // 2) Subir Video -> placeholder
    window.subirVideo = () => {
        mostrarAlertaBootstrap("🚧 Aún la función no está disponible.", "warning");
    };

    // 3) Ver Historial -> abre modal y carga iframe
    window.verHistorial = () => {
        const iframe = document.getElementById("iframeHistorial");
        if (iframe) iframe.src = "historial.html";
        const modalEl = document.getElementById("modalHistorial");
        if (modalEl && window.bootstrap?.Modal) {
            new bootstrap.Modal(modalEl).show();
        } else {
            // fallback: abrir en nueva pestaña
            window.open("historial.html", "_blank");
        }
    };
});
