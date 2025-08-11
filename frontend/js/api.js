// js/api.js
const DEFAULT_URL = "https://lse-backend-479238723367.us-central1.run.app";
export const BACKEND_URL = (window.BACKEND_URL && String(window.BACKEND_URL).trim())
    ? String(window.BACKEND_URL).trim()
    : DEFAULT_URL;

// --------- Endpoints ---------
export async function pingSecuencias() {
    return fetch(`${BACKEND_URL}/api/secuencias`, { credentials: "include", cache: "no-store" });
}

export async function crearSecuencia({ nombre, tipo, valor, usuario_id, fecha }) {
    const body = {};
    if (nombre) body.nombre = nombre;
    if (tipo) body.tipo = tipo;
    if (valor) body.valor = valor;
    if (usuario_id != null) body.usuario_id = usuario_id;
    if (fecha) body.fecha = fecha;

    const r = await fetch(`${BACKEND_URL}/api/crear_secuencia`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
    });
    const txt = await r.text(); let data = null; try { data = JSON.parse(txt); } catch { }
    return { ok: r.ok && data?.ok, status: r.status, data, raw: txt };
}

export async function guardarFrame({ secuencia_id, frame, landmarks }) {
    const r = await fetch(`${BACKEND_URL}/api/guardar_frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ secuencia_id, frame, landmarks }),
    });
    const txt = await r.text(); let data = null; try { data = JSON.parse(txt); } catch { }
    return { ok: r.ok && data?.ok, status: r.status, data, raw: txt };
}

export async function historialListado({ nombre, desde, hasta, pagina = 1, tamanio = 20, solo_con_frames = false } = {}) {
    const q = new URLSearchParams();
    if (nombre) q.set("nombre", nombre);
    if (desde) q.set("desde", desde);
    if (hasta) q.set("hasta", hasta);
    q.set("pagina", String(pagina));
    q.set("tamanio", String(tamanio));
    if (solo_con_frames) q.set("solo_con_frames", "1");

    const r = await fetch(`${BACKEND_URL}/api/historial?${q.toString()}`, { credentials: "include" });
    return r.json();
}

export async function historialDetalle(secuencia_id) {
    const r = await fetch(`${BACKEND_URL}/api/historial/${secuencia_id}`, { credentials: "include" });
    return r.json();
}

export function exportarUrl({ formato = "csv", secuencia_id, nombre, desde, hasta } = {}) {
    const q = new URLSearchParams();
    q.set("formato", formato);
    if (secuencia_id != null) q.set("secuencia_id", String(secuencia_id));
    if (nombre) q.set("nombre", nombre);
    if (desde) q.set("desde", desde);
    if (hasta) q.set("hasta", hasta);
    return `${BACKEND_URL}/api/exportar?${q.toString()}`;
}

export function logout() {
    return fetch(`${BACKEND_URL}/logout`, { credentials: "include" });
}
