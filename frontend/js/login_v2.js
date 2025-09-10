// login_v2.js — LOCAL y NUBE con fallback, timeout y mejores errores
document.addEventListener("DOMContentLoaded", () => {
    // ------- DOM -------
    const usuario = document.getElementById("usuario");
    const contrasena = document.getElementById("contrasena");
    const btnAcceder = document.getElementById("btnAcceder");
    const errorBox = document.getElementById("error-box");
    const toggleSpan = document.getElementById("togglePassword");
    const toggleIcon = document.getElementById("icono-ojo");
    const anio = document.getElementById("anio");
    if (anio) anio.textContent = new Date().getFullYear();

    // ------- Backend autodetectable (local ↔ nube) -------
    function servedByFlaskSameOrigin() {
        // Si el backend también sirve el frontend, evitamos CORS usando la misma origin
        // Heurística: si el path raíz devuelve contenido y no estás en 5500/5173 típicos de dev
        const p = location.port;
        const devPorts = new Set(["5500", "5173"]);
        return !devPorts.has(p) && (location.hostname === "127.0.0.1" || location.hostname === "localhost");
    }

    function computeDefaultBackend() {
        const proto = location.protocol;
        const host = location.hostname;

        // 1) Si el frontend lo sirve Flask (misma origin), usa origin directo (sin CORS)
        if (servedByFlaskSameOrigin()) {
            return location.origin; // ej: http://127.0.0.1:8081 o 8080
        }

        // 2) Modo desarrollo: prioriza 8081 y luego 8080 (ajusta a tu preferencia)
        const isLocal = host === "localhost" || host === "127.0.0.1";
        if (isLocal) {
            // Cambia el orden si prefieres 8080 primero
            return `${proto}//127.0.0.1:8081`;
        }

        // 3) Producción (Cloud Run)
        return "https://lse-backend-479238723367.us-central1.run.app";
    }

    // Permite forzar un backend desde consola:
    // localStorage.setItem('BACKEND_URL','http://127.0.0.1:8081'); location.reload();
    const LS_OVERRIDE = (localStorage.getItem("BACKEND_URL") || "").trim();
    const GLOBAL_OVERRIDE = (window.BACKEND_URL || "").trim();
    let BACKEND = LS_OVERRIDE || GLOBAL_OVERRIDE || computeDefaultBackend();

    // Fallback rápido: si elegimos 8081 y falla el fetch, probaremos 8080 una vez
    const FALLBACKS = [];
    if (BACKEND.includes("127.0.0.1:8081")) FALLBACKS.push(BACKEND.replace(":8081", ":8080"));
    if (BACKEND.includes("127.0.0.1:8080")) FALLBACKS.push(BACKEND.replace(":8080", ":8081"));

    // ------- Helpers -------
    const showError = (msg) => {
        if (!errorBox) return;
        errorBox.innerHTML = `<span class="error-text">${msg}</span>`;
    };
    const clearError = () => (errorBox.innerHTML = "");

    // Mostrar/Ocultar contraseña (accesible)
    function togglePassword() {
        if (!contrasena || !toggleIcon || !toggleSpan) return;
        const hidden = contrasena.type === "password";
        contrasena.type = hidden ? "text" : "password";
        toggleIcon.classList.toggle("bi-eye", !hidden);
        toggleIcon.classList.toggle("bi-eye-slash", hidden);
        toggleSpan.title = hidden ? "Ocultar contraseña" : "Mostrar contraseña";
        toggleSpan.setAttribute("aria-pressed", String(hidden));
    }

    if (toggleSpan) {
        toggleSpan.setAttribute("role", "button");
        toggleSpan.setAttribute("tabindex", "0");
        toggleSpan.setAttribute("aria-label", "Mostrar u ocultar contraseña");
        toggleSpan.setAttribute("aria-pressed", "false");
        toggleSpan.addEventListener("click", togglePassword);
        toggleSpan.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                togglePassword();
            }
        });
    }

    // Enter para enviar
    [usuario, contrasena].forEach((el) =>
        el?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") btnAcceder?.click();
        })
    );

    // ------- Utils fetch con timeout -------
    async function fetchJSON(url, opts = {}, timeoutMs = 10000) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...opts, signal: controller.signal });
            let data = {};
            try {
                data = await res.clone().json();
            } catch (_) {
                // no-op si no hay JSON
            }
            return { res, data };
        } finally {
            clearTimeout(t);
        }
    }

    // ------- Login -------
    btnAcceder?.addEventListener("click", async () => {
        clearError();
        const u = usuario?.value.trim();
        const p = contrasena?.value.trim();

        if (!u || !p) {
            showError("⚠️ Completa todos los campos.");
            return;
        }

        const originalHTML = btnAcceder.innerHTML;
        btnAcceder.disabled = true;
        btnAcceder.innerHTML = `
      <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
      Accediendo...
    `;

        // Intentar contra BACKEND y (si falla) contra un fallback local
        const targets = [BACKEND, ...FALLBACKS];

        let lastError = null;
        for (let i = 0; i < targets.length; i++) {
            const base = targets[i];
            try {
                const { res, data } = await fetchJSON(`${base}/login`, {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ usuario: u, contrasena: p }),
                });

                if (res.ok && data?.ok) {
                    // Autenticación OK
                    window.location.replace("sistema_v2.html");
                    return;
                }

                // Error con respuesta del backend
                if (res.status === 401) {
                    showError(data?.message || "Credenciales inválidas.");
                    return;
                }
                if (res.status === 400) {
                    showError(data?.message || "Solicitud inválida.");
                    return;
                }

                // Otros estados (500, 404, etc.)
                showError(data?.message || `Error del servidor (${res.status}).`);
                return;

            } catch (e) {
                // Network error / CORS / timeout
                lastError = e;
                // Si fue abort (timeout) o CORS, probamos siguiente target
                if (i < targets.length - 1) {
                    continue;
                }
            }
        }

        // Si llegamos aquí, no funcionó ningún target
        if (lastError?.name === "AbortError") {
            showError("⏱️ Tiempo de espera agotado. Verifica que el backend esté encendido.");
        } else {
            // Pista rápida para CORS: cuando hay preflight bloqueado, suele verse como TypeError/Failed to fetch
            showError("❌ No se pudo conectar con el backend. Revisa CORS/puerto o usa BACKEND_URL.");
            console.error(lastError);
        }

        btnAcceder.disabled = false;
        btnAcceder.innerHTML = originalHTML;
    });
});
