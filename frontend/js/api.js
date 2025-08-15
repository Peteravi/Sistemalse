// js/api.js
// ================================
// Configuración base
// ================================
const DEFAULT_URL = "https://lse-backend-479238723367.us-central1.run.app";
export const BACKEND_URL = (window.BACKEND_URL && String(window.BACKEND_URL).trim())
    ? String(window.BACKEND_URL).trim()
    : DEFAULT_URL;

// Utilidad interna: parseo seguro de JSON
async function parseJsonSafe(response) {
    const txt = await response.text();
    try { return { data: JSON.parse(txt), raw: txt }; }
    catch { return { data: null, raw: txt }; }
}

// ================================
// Endpoints
// ================================

/**
 * Ping del backend (usa /api/historial como “salud”)
 * Devuelve Response (no JSON), útil para saber si el backend responde.
 */
export async function pingSecuencias() {
    return fetch(`${BACKEND_URL}/api/historial?pagina=1&tamanio=1`, {
        credentials: "include",
        cache: "no-store",
    });
}

/**
 * Crear secuencia con soporte de categorización.
 * @param {Object} params
 * @param {string} [params.nombre]
 * @param {string} [params.tipo]            // numero|fecha|cantidad|texto
 * @param {string} [params.valor]
 * @param {number} [params.usuario_id]
 * @param {string|Date} [params.fecha]      // ISO string recomendado
 * @param {string} [params.categoria_slug]  // 'letra'|'numero'|'palabra'|'expresion_facial'|'saludo'|'otro'
 * @param {string} [params.subcategoria]    // 'A','5','hola','feliz', etc.
 * @returns {Promise<{ok:boolean,status:number,data:any,raw:string}>}
 */
export async function crearSecuencia({
    nombre,
    tipo,
    valor,
    usuario_id,
    fecha,
    categoria_slug,
    subcategoria,
} = {}) {
    const body = {};
    if (nombre && String(nombre).trim()) body.nombre = String(nombre).trim();
    if (tipo && String(tipo).trim()) body.tipo = String(tipo).trim();
    if (valor && String(valor).trim()) body.valor = String(valor).trim();
    if (usuario_id != null) body.usuario_id = usuario_id;
    if (fecha) body.fecha = fecha;

    // Categorización opcional
    if (categoria_slug && String(categoria_slug).trim()) {
        body.categoria_slug = String(categoria_slug).trim().toLowerCase();
    }
    if (subcategoria && String(subcategoria).trim()) {
        body.subcategoria = String(subcategoria).trim();
    }

    const r = await fetch(`${BACKEND_URL}/api/crear_secuencia`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
    });

    const { data, raw } = await parseJsonSafe(r);
    return { ok: r.ok && data?.ok, status: r.status, data, raw };
}

/**
 * Guardar frame. Si NO envías secuencia_id, el backend creará la secuencia
 * implícitamente usando nombre/tipo/valor y/o categoria_slug/subcategoria.
 * @param {Object} params
 * @param {number} [params.secuencia_id]
 * @param {number} params.frame
 * @param {Array<{x:number,y:number,z:number}>} params.landmarks
 * @param {string} [params.nombre]
 * @param {string} [params.tipo]
 * @param {string} [params.valor]
 * @param {string} [params.categoria_slug]
 * @param {string} [params.subcategoria]
 * @param {number} [params.usuario_id]
 * @returns {Promise<{ok:boolean,status:number,data:any,raw:string}>}
 */
export async function guardarFrame({
    secuencia_id,
    frame,
    landmarks,
    nombre,
    tipo,
    valor,
    categoria_slug,
    subcategoria,
    usuario_id,
}) {
    const body = { secuencia_id, frame, landmarks };

    // Si no hay secuencia_id, permitir creación implícita
    if (!secuencia_id) {
        if (nombre && String(nombre).trim()) body.nombre = String(nombre).trim();
        if (tipo && String(tipo).trim()) body.tipo = String(tipo).trim();
        if (valor && String(valor).trim()) body.valor = String(valor).trim();
        if (categoria_slug && String(categoria_slug).trim()) {
            body.categoria_slug = String(categoria_slug).trim().toLowerCase();
        }
        if (subcategoria && String(subcategoria).trim()) {
            body.subcategoria = String(subcategoria).trim();
        }
        if (usuario_id != null) body.usuario_id = usuario_id;
    }

    const r = await fetch(`${BACKEND_URL}/api/guardar_frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
    });

    const { data, raw } = await parseJsonSafe(r);
    return { ok: r.ok && data?.ok, status: r.status, data, raw };
}

/**
 * Listado del historial con filtros (incluye categoría/subcategoría).
 * @param {Object} params
 * @param {string} [params.nombre]
 * @param {string} [params.desde]
 * @param {string} [params.hasta]
 * @param {number} [params.pagina=1]
 * @param {number} [params.tamanio=20]
 * @param {boolean} [params.solo_con_frames=false]
 * @param {string} [params.categoria_slug]
 * @param {string} [params.subcategoria]
 */
export async function historialListado({
    nombre,
    desde,
    hasta,
    pagina = 1,
    tamanio = 20,
    solo_con_frames = false,
    categoria_slug,
    subcategoria,
} = {}) {
    const q = new URLSearchParams();
    if (nombre) q.set("nombre", nombre);
    if (desde) q.set("desde", desde);
    if (hasta) q.set("hasta", hasta);
    if (categoria_slug) q.set("categoria_slug", categoria_slug);
    if (subcategoria) q.set("subcategoria", subcategoria);
    q.set("pagina", String(pagina));
    q.set("tamanio", String(tamanio));
    if (solo_con_frames) q.set("solo_con_frames", "1");

    const r = await fetch(`${BACKEND_URL}/api/historial?${q.toString()}`, {
        credentials: "include",
        cache: "no-store",
    });
    return r.json();
}

/**
 * Detalle de una secuencia con frames.
 * @param {number} secuencia_id
 */
export async function historialDetalle(secuencia_id) {
    const r = await fetch(`${BACKEND_URL}/api/historial/${secuencia_id}`, {
        credentials: "include",
        cache: "no-store",
    });
    return r.json();
}

/**
 * Construir URL de exportación (CSV o JSON) con filtros, incl. categoría.
 * @param {Object} params
 * @param {"csv"|"json"} [params.formato="csv"]
 * @param {number} [params.secuencia_id]
 * @param {string} [params.nombre]
 * @param {string} [params.desde]
 * @param {string} [params.hasta]
 * @param {string} [params.categoria_slug]
 * @param {string} [params.subcategoria]
 */
export function exportarUrl({
    formato = "csv",
    secuencia_id,
    nombre,
    desde,
    hasta,
    categoria_slug,
    subcategoria,
} = {}) {
    const q = new URLSearchParams();
    q.set("formato", formato);
    if (secuencia_id != null) q.set("secuencia_id", String(secuencia_id));
    if (nombre) q.set("nombre", nombre);
    if (desde) q.set("desde", desde);
    if (hasta) q.set("hasta", hasta);
    if (categoria_slug) q.set("categoria_slug", categoria_slug);
    if (subcategoria) q.set("subcategoria", subcategoria);
    return `${BACKEND_URL}/api/exportar?${q.toString()}`;
}

export function logout() {
    return fetch(`${BACKEND_URL}/logout`, { credentials: "include" });
}
