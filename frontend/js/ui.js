// js/ui.js
// ---------------------------------------------------------
// UI principal para captura LSE con optimizaciones de rendimiento
// Mantiene TODAS las funcionalidades, rutas y atajos existentes
// ---------------------------------------------------------
import { crearSecuencia, guardarFrame, exportarUrl, logout } from "./api.js";
import { mostrarAlertaBootstrap, showToast, inferirTipoValor, setEstado } from "./utils.js";

document.addEventListener("DOMContentLoaded", () => {
    // ==============================
    // ------- DOM / Referencias ----
    // ==============================
    const $ = (id) => document.getElementById(id);
    const startBtn = $("startBtn");
    const stopBtn = $("stopBtn");
    const btnFS = $("btnPantallaCompleta");
    const iconFS = $("iconFullscreen");
    const cerrarSesionBtn = $("cerrarSesionBtn");

    const etiquetaInput = $("etiquetaGesto");
    const clearInputBtn = $("clearInputBtn");
    const categoriaSelect = $("categoriaSelect");

    const dCsv = $("downloadCsvOption");
    const dJson = $("downloadJsonOption");

    const captureWrapper = $("captureWrapper");
    const captureStage = $("captureStage");
    const video = $("videoFrontend");
    const overlay = $("overlay");
    const indicadorResolucion = $("indicadorResolucion");
    const indicadorGrabando = $("indicadorGrabando");
    const indicadorFps = $("indicadorFps");
    const iframeHistorial = $("iframeHistorial");
    const iframeMetricas = $("iframeMetricas");

    // Inyectar botón "Cambiar cámara" si no existe (respeta tu maquetado)
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

    // Permitir hacer clic en controles sobre el canvas
    try {
        if (overlay) overlay.style.pointerEvents = "none";
        const controlsEl = captureStage?.querySelector(".capture-controls");
        if (controlsEl) controlsEl.style.zIndex = "5";
    } catch { }

    // =======================================
    // ------- Estado / Rendimiento ----------
    // =======================================
    let secuenciaId = null;
    let capturing = false;
    let frameCounter = 0;
    let inflight = 0;       // peticiones guardar_frame en curso
    let inFlightMP = false; // inferencia mpHands en curso

    // Procesamiento a baja resolución para MediaPipe (mejor FPS)
    const PROC_W_DEFAULT = 320;
    const PROC_H_DEFAULT = 180;
    const procCanvas = document.createElement("canvas");
    const procCtx = procCanvas.getContext("2d", { willReadFrequently: true });
    procCanvas.width = PROC_W_DEFAULT;
    procCanvas.height = PROC_H_DEFAULT;

    // Envío al backend desacoplado del FPS de inferencia
    let TARGET_SEND_FPS = 10;
    let MIN_INTERVAL_MS = Math.floor(1000 / TARGET_SEND_FPS);
    let lastSentMs = 0;

    // Dibujar landmarks cada N frames para aligerar
    const DRAW_EVERY_N = 2;
    let drawTick = 0;

    // Medidor de FPS
    let frames = 0;
    let lastFpsT = performance.now();

    // Bucle de render
    let loopRunning = false;
    let usingRVFC = false; // requestVideoFrameCallback

    // ===================================
    // ------- Pantalla completa ---------
    // ===================================
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
            updateStage();
            setTimeout(updateStage, 80);
            requestAnimationFrame(updateStage);
        } catch { }
    };

    const fsUI = () => {
        const active = !!isFS() || fsFallback;
        captureWrapper?.classList.toggle("is-fullscreen", active);
        btnFS?.setAttribute("aria-pressed", String(active));
        iconFS?.classList.toggle("bi-arrows-fullscreen", !active);
        iconFS?.classList.toggle("bi-fullscreen-exit", active);

        const controlsEl = captureStage?.querySelector(".capture-controls");
        if (controlsEl) {
            controlsEl.style.bottom = active
                ? `max(.65rem, env(safe-area-inset-bottom, .65rem))`
                : ".65rem";
        }

        if (!active) {
            try {
                screen.orientation?.unlock?.();
            } catch { }
            restoreFromFS();
            ensureCaptureVisible();
            setTimeout(ensureCaptureVisible, 120);
        } else {
            updateStage();
            setTimeout(updateStage, 120);
            setTimeout(updateStage, 300);
        }
    };

    async function enterFSPrefer() {
        try {
            return await (
                captureStage.requestFullscreen?.() ||
                captureStage.webkitRequestFullscreen?.() ||
                captureStage.msRequestFullscreen?.() ||
                Promise.reject()
            );
        } catch { }
        try {
            return await (
                video.requestFullscreen?.() ||
                video.webkitRequestFullscreen?.() ||
                video.msRequestFullscreen?.() ||
                Promise.reject()
            );
        } catch { }
        try {
            return await (
                captureWrapper.requestFullscreen?.() ||
                captureWrapper.webkitRequestFullscreen?.() ||
                captureWrapper.msRequestFullscreen?.() ||
                Promise.reject()
            );
        } catch {
            throw new Error("no-fs");
        }
    }

    const toggleFS = async () => {
        try {
            if (!isFS() && !fsFallback) {
                try {
                    await enterFSPrefer();
                } catch {
                    fsFallback = true;
                    captureWrapper.classList.add("is-fullscreen");
                }
                try {
                    await screen.orientation?.lock?.("landscape");
                } catch { }
            } else {
                try {
                    await (
                        document.exitFullscreen?.() ||
                        document.webkitExitFullscreen?.() ||
                        document.msExitFullscreen?.()
                    );
                } catch { }
                fsFallback = false;
                captureWrapper.classList.remove("is-fullscreen");
            }
        } finally {
            fsUI();
        }
    };

    btnFS?.addEventListener("click", toggleFS);
    ["fullscreenchange", "webkitfullscreenchange", "msfullscreenchange"].forEach((e) =>
        document.addEventListener(e, fsUI)
    );
    captureStage?.addEventListener("dblclick", () => btnFS?.click());
    let tTap = 0;
    captureStage?.addEventListener("touchend", () => {
        const n = Date.now();
        if (n - tTap < 300) btnFS?.click();
        tTap = n;
    });
    document.addEventListener("keydown", (e) => {
        if ((e.key || "").toLowerCase() === "f") btnFS?.click();
    });

    // ===================================
    // ------- Vista (flip/zoom) ---------
    // ===================================
    function applyViewTransform(facing) {
        const flip = facing === "user" ? -1 : 1;
        const scale = facing === "user" ? 0.92 : 1;

        if (video) video.style.transform = `scaleX(${flip}) scale(${scale})`;
        if (overlay) overlay.style.transform = `scaleX(${flip}) scale(${scale})`;

        try {
            mpHands?.setOptions?.({ selfieMode: facing === "user" });
        } catch { }
    }

    // ===================================
    // ------- Cámara / getUserMedia -----
    // ===================================
    const LS = { facing: "lse_facing", devUser: "lse_dev_user", devEnv: "lse_dev_env" };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

    function pickVideoConstraints() {
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const idealW = isMobile ? 640 : 960;
        const idealH = isMobile ? 360 : 540;
        // Baja resolución fija para el canvas de procesamiento (no tocar)
        procCanvas.width = PROC_W_DEFAULT;
        procCanvas.height = PROC_H_DEFAULT;
        return { width: { ideal: idealW }, height: { ideal: idealH } };
    }

    const Cam = {
        stream: null,
        switching: false,
        devices: [],
        facing: localStorage.getItem(LS.facing) || "user",
        deviceIdUser: localStorage.getItem(LS.devUser) || null,
        deviceIdEnv: localStorage.getItem(LS.devEnv) || null,

        async ensureDevices() {
            try {
                let granted = false;
                try {
                    const p = await navigator.permissions?.query?.({ name: "camera" });
                    granted = p?.state === "granted";
                } catch { }
                if (!this.devices.length && !this.stream && !granted) {
                    const t = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    t.getTracks().forEach((tr) => tr.stop());
                    await sleep(80);
                }
            } catch { }
            this.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
            return this.devices;
        },

        pickByLabel(facing) {
            if (!this.devices.length) return null;
            const reF = /(front|frontal|user|delantera|selfie)/i;
            const reB = /(back|rear|environment|trasera|principal|wide)/i;
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
                this.stream?.getTracks?.().forEach((t) => t.stop());
                if (video) {
                    try { video.pause(); } catch { }
                    video.srcObject = null;
                }
            } catch { }
            await sleep(isIOS ? 350 : 250);
        },

        async openStream(targetFacing) {
            await this.ensureDevices();
            const common = pickVideoConstraints();

            const known = targetFacing === "user" ? this.deviceIdUser : this.deviceIdEnv;
            if (known) {
                try {
                    return await navigator.mediaDevices.getUserMedia({
                        audio: false,
                        video: { deviceId: { exact: known }, ...common },
                    });
                } catch { }
            }
            try {
                return await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { facingMode: { exact: targetFacing }, ...common },
                });
            } catch { }
            try {
                return await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { facingMode: { ideal: targetFacing }, ...common },
                });
            } catch { }
            const wanted = this.pickByLabel(targetFacing);
            return await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { deviceId: { exact: wanted }, ...common },
            });
        },

        async start(facing = this.facing) {
            if (this.switching) return;
            this.switching = true;
            try {
                await this.shutdown();
                const stream = await this.openStream(facing);
                this.stream = stream;

                video.srcObject = stream;
                video.muted = true;
                video.playsInline = true;
                await video.play().catch(() => { });

                updateStage();

                const tr = stream.getVideoTracks?.()[0];
                const settings = tr?.getSettings?.() || {};
                const fm = (settings.facingMode || "").toLowerCase();
                const did = settings.deviceId || null;
                const label = (tr?.label || "").toLowerCase();
                const realFacing =
                    fm ||
                    (/(back|rear|environment|trasera|principal|wide)/i.test(label) ? "environment" : "user");

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
                        const s2 = await navigator.mediaDevices.getUserMedia({
                            audio: false,
                            video: { deviceId: { exact: correctId }, ...pickVideoConstraints() },
                        });
                        this.stream = s2;
                        video.srcObject = s2;
                        await video.play().catch(() => { });
                    }
                }

                this.facing = facing;
                localStorage.setItem(LS.facing, this.facing);
                applyViewTransform(this.facing);
            } catch (e) {
                if (e?.name === "NotReadableError") {
                    mostrarAlertaBootstrap(
                        "❌ Cámara ocupada por otra app (WhatsApp/Cámara/Meet). Ciérrala y reintenta.",
                        "danger",
                        7000
                    );
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
        },
    };

    // ===================================
    // ------- MediaPipe Hands -----------
    // ===================================
    let mpHands = null;

    function initMP() {
        if (mpHands) return;
        if (typeof Hands === "undefined") {
            throw new Error("MediaPipe Hands no está cargado. Incluye los <script> en el HTML.");
        }
        mpHands = new Hands({
            locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
        });
        mpHands.setOptions({
            maxNumHands: 1,
            modelComplexity: 0,          // ↓ complejidad = +FPS
            minDetectionConfidence: 0.6,
            minTrackingConfidence: 0.5,
            selfieMode: true,            // se sincroniza en applyViewTransform
        });
        mpHands.onResults(onResults);
    }

    function clearOverlay() {
        const ctx = overlay?.getContext?.("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, overlay.width, overlay.height);
    }

    function drawHandLandmarks(landmarks) {
        const ctx = overlay?.getContext?.("2d");
        if (!ctx) return;
        if (!window.drawConnectors || !window.drawLandmarks || !window.HAND_CONNECTIONS) return;
        try {
            ctx.save();
            window.drawConnectors(ctx, landmarks, window.HAND_CONNECTIONS);
            window.drawLandmarks(ctx, landmarks, { radius: 3 });
            ctx.restore();
        } catch { }
    }

    function updateFpsCounter() {
        frames++;
        const now = performance.now();
        if (now - lastFpsT >= 1000) {
            const fps = Math.round((frames * 1000) / (now - lastFpsT));
            if (indicadorFps) indicadorFps.textContent = `FPS: ${fps}`;
            frames = 0;
            lastFpsT = now;

            // Adaptación simple del rate de envío
            if (fps < 18 && TARGET_SEND_FPS !== 8) {
                TARGET_SEND_FPS = 8;
                MIN_INTERVAL_MS = Math.floor(1000 / TARGET_SEND_FPS);
            } else if (fps > 24 && TARGET_SEND_FPS !== 12) {
                TARGET_SEND_FPS = 12;
                MIN_INTERVAL_MS = Math.floor(1000 / TARGET_SEND_FPS);
            }
        }
    }

    async function onResults(res) {
        // Dibujo intermitente (reduce costo gráfico)
        drawTick++;
        clearOverlay();
        const list = res.multiHandLandmarks || [];
        if (list.length > 0 && (drawTick % DRAW_EVERY_N === 0)) {
            drawHandLandmarks(list[0]);
        }

        // Envío al backend (throttle)
        if (!capturing) return;
        const now = performance.now();
        if (now - lastSentMs < MIN_INTERVAL_MS) return;

        const pts = (list[0] || []).map((p) => ({
            x: Math.round(p.x * 1000) / 1000,
            y: Math.round(p.y * 1000) / 1000,
            z: Math.round(p.z * 1000) / 1000,
        }));
        if (!pts.length) return;

        lastSentMs = now;
        await sendFrame(pts);
    }

    function processOneFrame() {
        try {
            const vw = video.videoWidth || procCanvas.width;
            const vh = video.videoHeight || procCanvas.height;
            // Redimensionamos el frame al canvas de procesamiento
            procCtx.drawImage(video, 0, 0, vw, vh, 0, 0, procCanvas.width, procCanvas.height);

            // Evitamos enviar múltiples inferencias simultáneas
            if (!inFlightMP) {
                inFlightMP = true;
                mpHands.send({ image: procCanvas })
                    .catch(console.error)
                    .finally(() => { inFlightMP = false; });
            }
        } catch { }
        updateFpsCounter();
    }

    function startLoop() {
        if (loopRunning) return;
        loopRunning = true;

        // Sincroniza con frames reales del video cuando es posible
        if ("requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof video.requestVideoFrameCallback === "function") {
            usingRVFC = true;
            const step = () => {
                if (!loopRunning) return;
                processOneFrame();
                video.requestVideoFrameCallback(step);
            };
            video.requestVideoFrameCallback(step);
        } else {
            usingRVFC = false;
            const step = () => {
                if (!loopRunning) return;
                processOneFrame();
                requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        }
    }

    function stopLoop() {
        loopRunning = false;
        inFlightMP = false;
    }

    // ===================================
    // ------- Backend helpers -----------
    // ===================================
    async function ensureSecuencia() {
        if (secuenciaId) return secuenciaId;

        const entrada = (etiquetaInput?.value || "").trim();
        const { tipo, valor, nombre } = inferirTipoValor(entrada);

        if (!nombre && !valor) {
            mostrarAlertaBootstrap(
                "⚠️ Ingresa el nombre del gesto, número (1-100), fecha (YYYY-MM-DD) o cantidad.",
                "warning",
                6000
            );
            etiquetaInput?.focus();
            throw new Error("Etiqueta vacía");
        }

        const catSlug = categoriaSelect?.value || undefined;
        let subcat = undefined;
        if (catSlug === "letra" || catSlug === "numero" || catSlug === "saludo" || catSlug === "palabra") {
            subcat = entrada || undefined;
        }

        const { ok, status, data } = await crearSecuencia({
            nombre,
            tipo,
            valor,
            categoria_slug: catSlug,
            subcategoria: subcat,
        });

        if (!ok) {
            mostrarAlertaBootstrap(`❌ Error creando secuencia (${status})`, "danger", 6000);
            throw new Error("crear_secuencia");
        }

        secuenciaId = data.secuencia_id;
        return secuenciaId;
    }

    async function sendFrame(pts) {
        if (!secuenciaId || inflight >= 1) return; // 1 vuelo concurrente máximo
        inflight++;
        try {
            await guardarFrame({
                secuencia_id: secuenciaId,
                frame: frameCounter,
                landmarks: pts,
            });
            frameCounter++;
        } catch (e) {
            console.error("guardar_frame", e);
        } finally {
            inflight--;
        }
    }

    // ===================================
    // ------- Stage / HUD / Layout ------
    // ===================================
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

    video?.addEventListener("loadedmetadata", () => {
        updateStage();
        ensureCaptureVisible();
    });
    window.addEventListener("resize", () => {
        updateStage();
        ensureCaptureVisible();
    });
    if (window.visualViewport)
        window.visualViewport.addEventListener("resize", () =>
            setTimeout(() => {
                updateStage();
                ensureCaptureVisible();
            }, 60)
        );
    window.addEventListener("orientationchange", () => {
        setTimeout(() => {
            updateStage();
            ensureCaptureVisible();
        }, 180);
        setTimeout(ensureCaptureVisible, 600);
    });

    // Pausar el loop cuando la pestaña no está visible (ahorra CPU)
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            stopLoop();
        } else if (capturing) {
            startLoop();
            setTimeout(() => {
                updateStage();
                ensureCaptureVisible();
            }, 100);
        }
    });

    // ===================================
    // ------- Acciones principales ------
    // ===================================
    async function startCapture() {
        await ensureSecuencia();
        initMP();
        await Cam.start(Cam.facing);
        frameCounter = 0;
        lastSentMs = 0;
        capturing = true;
        startLoop();
        setEstado("🟢 Capturando…");
        indicadorGrabando?.classList?.remove("d-none");
        mostrarAlertaBootstrap("🟢 Captura iniciada", "success");
        ensureCaptureVisible();
    }

    function stopCapture() {
        capturing = false;
        stopLoop();
        Cam.shutdown();
        setEstado("🔴 Detenido", true);
        indicadorGrabando?.classList?.add("d-none");
        mostrarAlertaBootstrap("⛔ Captura detenida", "danger");
    }

    async function switchCamera() {
        await Cam.ensureDevices();
        if (Cam.devices.length <= 1)
            return mostrarAlertaBootstrap("ℹ️ Solo hay una cámara disponible.", "warning");

        const target = Cam.facing === "user" ? "environment" : "user";
        mostrarAlertaBootstrap(
            `🔄 Cambiando a cámara ${target === "user" ? "frontal" : "trasera"}…`,
            "info"
        );
        try {
            await Cam.start(target);
            applyViewTransform(target);
            setEstado(
                capturing
                    ? `🟢 Capturando (${target === "user" ? "frontal" : "trasera"})…`
                    : `👀 Vista previa (${target === "user" ? "frontal" : "trasera"}) lista`
            );
            showToast("✅ Cámara cambiada", "success");
            ensureCaptureVisible();
        } catch (e) {
            if (e?.name === "NotReadableError")
                mostrarAlertaBootstrap(
                    "❌ Cámara ocupada por otra app (WhatsApp/Cámara/Meet). Ciérrala y reintenta.",
                    "danger",
                    7000
                );
            else mostrarAlertaBootstrap("❌ No se pudo cambiar la cámara", "danger");
        }
    }

    // ===================================
    // ------- Listeners UI --------------
    // ===================================
    clearInputBtn?.addEventListener("click", () => {
        etiquetaInput.value = "";
        etiquetaInput.focus();
    });

    startBtn?.addEventListener("click", async () => {
        if (capturing || Cam.switching) return;
        try {
            await startCapture();
        } catch (e) {
            console.error(e);
            const msg = e?.message?.includes("MediaPipe")
                ? "❌ MediaPipe Hands no está cargado. Asegúrate de incluir los <script> en el HTML."
                : e?.message || "No se pudo iniciar.";
            mostrarAlertaBootstrap(msg, "danger", 7000);
            setEstado("🔴 Esperando…", true);
        }
    });

    stopBtn?.addEventListener("click", () => {
        if (!capturing || Cam.switching) return;
        stopCapture();
    });

    btnCam?.addEventListener("click", async () => {
        if (Cam.switching) return;
        await switchCamera();
    });

    dCsv?.addEventListener("click", (e) => {
        e.preventDefault();
        const url = exportarUrl({
            formato: "csv",
            categoria_slug: categoriaSelect?.value || undefined,
            subcategoria: (etiquetaInput?.value || "").trim() || undefined,
        });
        window.open(url, "_blank");
    });

    dJson?.addEventListener("click", (e) => {
        e.preventDefault();
        const url = exportarUrl({
            formato: "json",
            categoria_slug: categoriaSelect?.value || undefined,
            subcategoria: (etiquetaInput?.value || "").trim() || undefined,
        });
        window.open(url, "_blank");
    });

    cerrarSesionBtn?.addEventListener("click", async () => {
        try {
            await logout();
            showToast?.("Sesión cerrada.", "info");
            window.location.href = "login.html";
        } catch {
            showToast?.("No se pudo cerrar sesión.", "danger");
        }
    });

    // ===================================
    // ------- APIs expuestas (header) ----
    // ===================================
    window.capturarSecuencia = async () => {
        try {
            await Cam.start(Cam.facing); // permisos + preview
            applyViewTransform(Cam.facing);
            setEstado("👀 Vista previa lista. Pulsa «Iniciar» para grabar.");
            mostrarAlertaBootstrap("📸 Permiso de cámara concedido. Vista previa activa.", "success");
            ensureCaptureVisible();
        } catch (e) { /* no-op */ }
    };

    window.verMetricas = function () {
        try {
            const url = "metricas.html";
            const iframe = document.getElementById("iframeMetricas");
            if (iframe) iframe.src = url;
            const modal = new bootstrap.Modal(document.getElementById("modalMetricas"));
            modal.show();
        } catch (e) {
            console.error(e);
            window.open("metricas.html", "_blank");
        }
    };

    window.verHistorial = function () {
        try {
            if (iframeHistorial) iframeHistorial.src = "historial.html";
            const modal = new bootstrap.Modal(document.getElementById("modalHistorial"));
            modal.show();
        } catch (e) {
            console.error(e);
            window.open("historial.html", "_blank");
        }
    };

    // ===================================
    // ------- Limpieza -------------------
    // ===================================
    window.addEventListener("beforeunload", () => {
        try {
            capturing = false;
            stopLoop();
            Cam.shutdown();
        } catch { }
    });

    // Estado inicial / HUD
    try {
        video?.setAttribute("playsinline", "");
        video?.setAttribute("autoplay", "");
        video?.setAttribute("muted", "");
        video?.removeAttribute("controls");
    } catch { }
    setEstado("🔴 Esperando…", true);
    indicadorGrabando?.classList?.add("d-none");
    updateStage();
    fsUI();
    ensureCaptureVisible();

    // Ajuste inicial del espejo/zoom según facing guardado
    applyViewTransform(Cam.facing || "user");
});
