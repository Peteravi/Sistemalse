// metricas.js — listo para LOCAL y NUBE

// ====================
// Backend autodetectable
// ====================
function computeDefaultBackend() {
    const host = location.hostname;
    const proto = location.protocol;
    const isLocal = host === "localhost" || host === "127.0.0.1";
    // Local: Flask en 8080 | Nube: Cloud Run
    return isLocal ? `${proto}//127.0.0.1:5000` : "https://lse-backend-479238723367.us-central1.run.app";
}

// Permite forzar un backend sin tocar el código:
//   localStorage.setItem('BACKEND_URL','http://192.168.1.10:8080'); location.reload();
const LS_OVERRIDE = (localStorage.getItem("BACKEND_URL") || "").trim();
const GLOBAL_OVERRIDE = (window.BACKEND_URL || "").trim();
const BACKEND = LS_OVERRIDE || GLOBAL_OVERRIDE || computeDefaultBackend();

// ====================
// Dashboard Métricas
// ====================
(() => {
    const el = (id) => document.getElementById(id);
    const kSecuencias = el("kSecuencias");
    const kFrames = el("kFrames");
    const kDuracion = el("kDuracion");
    const kFps = el("kFps");
    const fDesde = el("fDesde");
    const fHasta = el("fHasta");
    const fFps = el("fFps");
    const btnAplicar = el("btnAplicar");
    const ulCats = el("listaCategorias");
    const lastUpdateText = el("lastUpdateText");

    const ctxSeq = el("chartSecuenciasDia");
    const ctxFr = el("chartFramesDia");
    const ctxHr = el("chartHoras");

    // Auto-refresh controls
    const autoChk = el("autoRefreshChk");
    const autoSec = el("autoRefreshSec");

    let chSeq, chFr, chHr;
    let autoTimer = null;
    let loading = false;        // evita solapes
    let pendingRefresh = false; // reintento si llega otra orden mientras carga

    const fmt = (n) => new Intl.NumberFormat().format(n || 0);
    const nowLocal = () => new Date().toLocaleString();

    // ------------- CARGA -------------
    async function cargar() {
        if (loading) { pendingRefresh = true; return; }
        loading = true;
        try {
            const q = new URLSearchParams();
            if (fDesde?.value) q.set("desde", fDesde.value);
            if (fHasta?.value) q.set("hasta", fHasta.value);
            if (fFps?.value) q.set("fps", fFps.value);

            const url = `${BACKEND}/api/metrics/overview?${q.toString()}`;
            const r = await fetch(url, { credentials: "include" });

            // Validación de contenido para evitar "Unexpected token <"
            const contentType = r.headers.get("content-type") || "";
            if (!contentType.includes("application/json")) {
                const text = await r.text();
                throw new Error(`La respuesta no es JSON. HTTP ${r.status}. Detalle: ${text.slice(0, 120)}…`);
            }

            const j = await r.json();
            if (!j.ok) throw new Error(j.error || `Error de métricas (HTTP ${r.status})`);
            const m = j.metrics;

            // KPIs
            kSecuencias.textContent = fmt(m.totales.secuencias);
            kFrames.textContent = fmt(m.totales.frames);
            kDuracion.textContent = (m.promedios.duracion_estimada_seg != null)
                ? fmt(Number(m.promedios.duracion_estimada_seg).toFixed(2))
                : "—";
            kFps.textContent = m.promedios.fps_asumido;

            // Listado de categorías (máx 8 para no saturar)
            ulCats.innerHTML = "";
            (m.categorias || []).slice(0, 8).forEach(c => {
                const li = document.createElement("li");
                li.className = "d-flex justify-content-between";
                li.innerHTML = `<span>${c.slug}${c.subcategoria ? ' · <small class="text-secondary">' + c.subcategoria + '</small>' : ''}</span><b>${fmt(c.total)}</b>`;
                ulCats.appendChild(li);
            });

            // Secuencias por día
            const labelsS = (m.series?.secuencias_por_dia || []).map(d => d.dia);
            const dataS = (m.series?.secuencias_por_dia || []).map(d => d.total);
            chSeq?.destroy();
            chSeq = new Chart(ctxSeq, {
                type: "line",
                data: { labels: labelsS, datasets: [{ label: "Secuencias", data: dataS }] },
                options: { responsive: true, tension: .3 }
            });

            // Frames por día
            const labelsF = (m.series?.frames_por_dia || []).map(d => d.dia);
            const dataF = (m.series?.frames_por_dia || []).map(d => d.total);
            chFr?.destroy();
            chFr = new Chart(ctxFr, {
                type: "bar",
                data: { labels: labelsF, datasets: [{ label: "Frames", data: dataF }] },
                options: { responsive: true }
            });

            // Actividad por hora
            const labelsH = Array.from({ length: 24 }, (_, i) => i);
            const mapaH = new Map((m.horas || []).map(h => [h.hora_0_23, h.total]));
            const dataH = labelsH.map(h => mapaH.get(h) || 0);
            chHr?.destroy();
            chHr = new Chart(ctxHr, {
                type: "bar",
                data: { labels: labelsH, datasets: [{ label: "Secuencias", data: dataH }] },
                options: { responsive: true }
            });

            if (lastUpdateText) lastUpdateText.textContent = nowLocal();
        } catch (e) {
            alert(e.message || "No se pudo cargar métricas.");
            console.error("Métricas:", e);
        } finally {
            loading = false;
            if (pendingRefresh) {
                pendingRefresh = false;
                setTimeout(() => cargar().catch(console.warn), 50);
            }
        }
    }

    // ------------- AUTO REFRESH -------------
    function clearAutoTimer() {
        if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    }

    function scheduleAuto() {
        clearAutoTimer();
        const sec = Math.max(3, parseInt(autoSec?.value || "10", 10));
        autoTimer = setInterval(() => { cargar().catch(e => console.warn("Auto-refresh error:", e)); }, sec * 1000);
    }

    function setAutoRefresh(enabled) {
        if (!autoChk) return;
        autoChk.checked = !!enabled;
        if (enabled) scheduleAuto(); else clearAutoTimer();
    }

    // Pausar en background para ahorrar recursos
    document.addEventListener("visibilitychange", () => {
        if (!autoChk?.checked) return;
        if (document.hidden) clearAutoTimer(); else cargar().finally(scheduleAuto);
    });

    // Eventos UI
    btnAplicar?.addEventListener("click", () => cargar().catch(e => alert(e.message)));
    autoChk?.addEventListener("change", () => setAutoRefresh(autoChk.checked));
    autoSec?.addEventListener("change", () => { if (autoChk?.checked) scheduleAuto(); });
    fDesde?.addEventListener("change", () => cargar().catch(console.warn));
    fHasta?.addEventListener("change", () => cargar().catch(console.warn));
    fFps?.addEventListener("change", () => cargar().catch(console.warn));

    // Fechas por defecto: últimos 14 días
    const hoy = new Date();
    const d14 = new Date(hoy); d14.setDate(hoy.getDate() - 13);
    if (el("fHasta")) el("fHasta").valueAsDate = hoy;
    if (el("fDesde")) el("fDesde").valueAsDate = d14;

    // Primera carga
    cargar().catch(e => alert(e.message));

    // (Opcional) activar auto al abrir:
    // setAutoRefresh(true);
})();
