export function mostrarAlertaBootstrap(mensaje, tipo = "info", duracion = 4000) {
    const contenedor = document.getElementById("toastContainer");
    if (!contenedor) return alert(mensaje);
    const id = `toast-${Date.now()}`;
    const toast = document.createElement("div");
    toast.className = `toast align-items-center text-bg-${tipo} border-0 shadow`;
    toast.id = id;
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "assertive");
    toast.setAttribute("aria-atomic", "true");
    toast.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${mensaje}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto"
        data-bs-dismiss="toast" aria-label="Cerrar"></button>
    </div>`;
    contenedor.appendChild(toast);
    const bsToast = new bootstrap.Toast(toast, { delay: duracion });
    bsToast.show();
    toast.addEventListener("hidden.bs.toast", () => toast.remove());
}

export const showToast = (msg, variant = "primary") =>
    mostrarAlertaBootstrap(
        msg,
        { primary: "primary", success: "success", warning: "warning", danger: "danger", secondary: "secondary" }[variant] || "primary"
    );

// ---------- Parsers: número / fecha / cantidad ----------
const NUM_RE = /^\s*(\d{1,3})\s*$/;
const FECHA_RE = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/; // YYYY-MM-DD
const CANT_RE = /^\s*(\d+(?:[.,]\d+)?)\s*(?:unid(?:ades)?|u|pcs|kg|g|l|ml)?\s*$/i;

export function inferirTipoValor(input) {
    const raw = (input || "").trim();
    if (!raw) return { tipo: null, valor: null, nombre: "" };

    const mN = raw.match(NUM_RE);
    if (mN) {
        const n = parseInt(mN[1], 10);
        if (n >= 1 && n <= 100) return { tipo: "numero", valor: String(n), nombre: raw };
    }
    const mF = raw.match(FECHA_RE);
    if (mF) return { tipo: "fecha", valor: `${mF[1]}-${mF[2]}-${mF[3]}`, nombre: raw };

    const mC = raw.match(CANT_RE);
    if (mC) {
        const v = String(mC[1]).replace(",", ".");
        return { tipo: "cantidad", valor: v, nombre: raw };
    }
    return { tipo: "texto", valor: raw, nombre: raw };
}

// ---------- UI helpers ----------
export function setEstado(txt, danger = false) {
    const el = document.getElementById("estadoReconocimiento");
    if (!el) return;
    el.textContent = txt;
    el.classList.toggle("text-danger", danger);
    el.classList.toggle("text-success", !danger);
}

export function crearBadgesEstado(videoElement) {
    const statusBar = document.createElement("div");
    statusBar.style.maxWidth = "640px";
    statusBar.style.margin = "8px auto 0";
    statusBar.style.display = "grid";
    statusBar.style.gridTemplateColumns = "1fr 1fr";
    statusBar.style.gap = "8px";
    const badgeBase = `
    display:inline-block;padding:6px 10px;border-radius:999px;font-weight:700;
    text-align:center;box-shadow:0 6px 16px rgba(0,0,0,0.12);background:#fff;`;
    const camBadge = document.createElement("div"); camBadge.style.cssText = badgeBase; camBadge.textContent = "📷 Cámara: —";
    const netBadge = document.createElement("div"); netBadge.style.cssText = badgeBase; netBadge.textContent = "🌐 Red: —";
    videoElement.parentElement?.insertAdjacentElement("afterend", statusBar);
    statusBar.appendChild(camBadge); statusBar.appendChild(netBadge);
    return { statusBar, camBadge, netBadge };
}

export function pintarBadge(el, level) {
    const m = {
        ok: { bg: "#e8f5e9", fg: "#1b5e20" },
        warn: { bg: "#fff8e1", fg: "#ff6f00" },
        bad: { bg: "#ffebee", fg: "#b71c1c" },
        idle: { bg: "#eef2f7", fg: "#37474f" },
    }[level] || { bg: "#eef2f7", fg: "#37474f" };
    el.style.background = m.bg;
    el.style.color = m.fg;
}
