const BACKEND_BASE = window.BACKEND_URL || "https://lse-backend-479238723367.us-central1.run.app";

// ===== Estado =====
let pagina = 1;
let tamanio = 10;
let debounceTimer = null;
let filtroInicialAplicado = false;
let _categoriasCache = null;

// ===== Utils =====
function toLocal(dt) {
    try { return new Date(dt).toLocaleString(); } catch { return dt || "-"; }
}

function setLoading(tbody, msg = "Cargando...") {
    tbody.innerHTML = `
    <tr>
      <td colspan="5" class="text-center text-muted py-4">
        <div class="d-inline-flex align-items-center gap-2">
          <div class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></div>
          <span>${msg}</span>
        </div>
      </td>
    </tr>`;
}

function setEmpty(tbody, msg = "Sin resultados") {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">${msg}</td></tr>`;
}

function setError(tbody, msg = "Error cargando datos") {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger py-4">${msg}</td></tr>`;
}

// Toast Bootstrap
function showToast(message, type = "success", delay = 3000) {
    const container = document.getElementById("toastContainer");
    if (!container) { alert(message); return; }
    const toast = document.createElement("div");
    toast.className = `toast align-items-center text-bg-${type} border-0 shadow`;
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "assertive");
    toast.setAttribute("aria-atomic", "true");
    toast.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">
        ${type === "success" ? '<i class="bi bi-check-circle me-2"></i>' : '<i class="bi bi-exclamation-triangle me-2"></i>'}
        ${message}
      </div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Cerrar"></button>
    </div>
  `;
    container.appendChild(toast);
    const bsToast = new bootstrap.Toast(toast, { autohide: true, delay });
    bsToast.show();
    toast.addEventListener("hidden.bs.toast", () => toast.remove());
}

// Fecha local -> YYYY-MM-DD (sin UTC shift)
function toInputDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function aplicarFiltroAutomatico() {
    if (filtroInicialAplicado) return;
    const desdeEl = document.getElementById("fDesde");
    const hastaEl = document.getElementById("fHasta");

    if (!desdeEl.value && !hastaEl.value) {
        const hoy = new Date();
        const hace7 = new Date();
        hace7.setDate(hoy.getDate() - 7);

        desdeEl.value = toInputDate(hace7);
        hastaEl.value = toInputDate(hoy);
    }
    filtroInicialAplicado = true;
}

async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, { credentials: "include", cache: "no-store", ...opts });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("Respuesta no válida del servidor"); }
    if (data && data.ok === false) throw new Error(data.error || "Error de API");
    return data;
}

// ===== Categorías (para filtro y modal) =====
async function fetchCategorias() {
    if (_categoriasCache) return _categoriasCache;
    try {
        const j = await fetchJSON(`${BACKEND_BASE}/api/categorias`);
        _categoriasCache = Array.isArray(j.categorias) ? j.categorias : [];
    } catch {
        _categoriasCache = [
            { slug: "letra", nombre: "Letra" },
            { slug: "numero", nombre: "Número" },
            { slug: "palabra", nombre: "Palabra" },
            { slug: "expresion_facial", nombre: "Expresión facial" },
            { slug: "saludo", nombre: "Saludo" },
            { slug: "otro", nombre: "Otro" }
        ];
    }
    return _categororiasCache;
}

async function poblarCategoriasFiltro() {
    const sel = document.getElementById("fCategoria");
    if (!sel) return;
    const cats = await fetchCategorias();
    const first = `<option value="">(Todas)</option>`;
    const opts = cats.map(c => `<option value="${c.slug}">${c.nombre}</option>`).join("");
    sel.innerHTML = first + opts;
}

async function poblarCategoriasModal() {
    const sel = document.getElementById("editCategoria");
    if (!sel) return;
    const cats = await fetchCategorias();
    const first = `<option value="">(Sin categoría)</option>`;
    const opts = cats.map(c => `<option value="${c.slug}">${c.nombre}</option>`).join("");
    sel.innerHTML = first + opts;
}

// ===== API edición =====
// Intentar PATCH y, si el preflight CORS lo bloquea, reintentar con PUT
async function patchSecuencia(id, payload) {
    const url = `${BACKEND_BASE}/api/secuencias/${id}`;
    try {
        return await _sendEdit(url, "PATCH", payload);
    } catch (err) {
        console.warn("PATCH falló, intentando PUT. Detalle:", err);
        return await _sendEdit(url, "PUT", payload);
    }
}
async function _sendEdit(url, method, payload) {
    const res = await fetch(url, {
        method,
        mode: "cors",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText} ${txt}`.trim());
    }
    const data = await res.json().catch(() => ({}));
    if (!data || data.ok === false) throw new Error(data?.error || "No se pudo actualizar");
    return data.secuencia;
}

// ===== Cargar listado =====
async function cargarHistorial() {
    aplicarFiltroAutomatico();

    const nombre = document.getElementById("fNombre")?.value?.trim() || "";
    const desde = document.getElementById("fDesde")?.value || "";
    const hasta = document.getElementById("fHasta")?.value || "";
    const categoria = document.getElementById("fCategoria")?.value || "";
    const subcat = document.getElementById("fSubcat")?.value?.trim() || "";

    const tbody = document.getElementById("historialBody");
    setLoading(tbody);

    const params = new URLSearchParams({
        pagina: String(pagina),
        tamanio: String(tamanio),
        solo_con_frames: "1",
    });
    if (nombre) params.append("nombre", nombre);
    if (desde) params.append("desde", desde);
    if (hasta) params.append("hasta", hasta);
    if (categoria) params.append("categoria_slug", categoria);
    if (subcat) params.append("subcategoria", subcat);

    try {
        const data = await fetchJSON(`${BACKEND_BASE}/api/historial?${params.toString()}`);

        tbody.innerHTML = "";
        if (!Array.isArray(data.items) || data.items.length === 0) {
            setEmpty(tbody);
            document.getElementById("histInfo").textContent = "";
            document.getElementById("prevPage").disabled = true;
            document.getElementById("nextPage").disabled = true;
            return;
        }

        data.items.forEach((item) => {
            const catSlug = item?.categoria?.slug || "";
            const sub = item?.categoria?.subcategoria || "";
            const catBadge = (catSlug || sub)
                ? `<div class="small text-muted mt-1">
             <span class="badge text-bg-light border">${catSlug || "-"}</span>
             ${sub ? `<span class="ms-1">• ${sub}</span>` : ""}
           </div>`
                : "";

            const tr = document.createElement("tr");
            tr.innerHTML = `
        <td>${toLocal(item.fecha)}</td>
        <td>
          ${item.nombre ?? "-"}
          ${catBadge}
        </td>
        <td>${item.usuario ?? "-"}</td>
        <td>${item.frames}</td>
        <td class="text-end">
          <div class="btn-group">
            <button class="btn btn-sm btn-outline-info btn-ver" data-id="${item.id}" title="Ver detalle" data-bs-toggle="tooltip">
              <i class="bi bi-eye"></i>
            </button>
            <button class="btn btn-sm btn-outline-primary btn-editar" data-id="${item.id}" title="Editar" data-bs-toggle="tooltip">
              <i class="bi bi-pencil-square"></i>
            </button>
          </div>
        </td>
      `;

            tr.querySelector(".btn-ver").addEventListener("click", () =>
                verDetalle(item.id, item.nombre, item.fecha, item.frames, item.usuario)
            );
            tr.querySelector(".btn-editar").addEventListener("click", async () =>
                abrirModalEdicion(item)
            );

            tbody.appendChild(tr);
        });

        const inicio = (pagina - 1) * tamanio + 1;
        const fin = inicio + data.items.length - 1;
        document.getElementById("histInfo").textContent = `Mostrando ${inicio}-${fin} de ${data.total}`;
        document.getElementById("prevPage").disabled = pagina <= 1;
        document.getElementById("nextPage").disabled = pagina * tamanio >= data.total;

        document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => new bootstrap.Tooltip(el));

    } catch (e) {
        setError(tbody);
        console.error("Error cargando historial:", e);
        showToast("Error cargando historial", "danger", 4000);
        document.getElementById("histInfo").textContent = "";
        document.getElementById("prevPage").disabled = true;
        document.getElementById("nextPage").disabled = true;
    }
}

// ===== Detalle =====
async function verDetalle(id, nombre, fecha, framesTotal, usuario) {
    const detalleBody = document.getElementById("detalleBody");
    const detalleInfo = document.getElementById("detalleInfo");
    const detalleMeta = document.getElementById("detalleMeta");

    detalleBody.innerHTML = `<tr><td colspan="2" class="text-center text-muted py-3">Cargando...</td></tr>`;
    detalleInfo.textContent = "";
    detalleMeta.textContent = `Secuencia #${id} • Etiqueta: ${nombre || "-"} • Usuario: ${usuario || "-"} • Fecha: ${toLocal(fecha)} • Frames: ${framesTotal}`;

    try {
        const data = await fetchJSON(`${BACKEND_BASE}/api/historial/${id}?pagina=1&tamanio=200`);

        const catSlug = data?.secuencia?.categoria?.slug || "";
        const catNom = data?.secuencia?.categoria?.nombre || "";
        const sub = data?.secuencia?.categoria?.subcategoria || "";
        if (catSlug || sub) {
            const base = `Secuencia #${id} • Etiqueta: ${nombre || "-"} • Usuario: ${usuario || "-"} • Fecha: ${toLocal(fecha)} • Frames: ${framesTotal}`;
            const catTxt = ` • Categoría: ${catNom || catSlug}${sub ? ` • Subcategoría: ${sub}` : ""}`;
            detalleMeta.textContent = base + catTxt;
        }

        const rows = data.secuencia?.frames || [];
        if (rows.length === 0) {
            detalleBody.innerHTML = `<tr><td colspan="2" class="text-center text-muted py-3">Sin frames</td></tr>`;
        } else {
            detalleBody.innerHTML = "";
            rows.forEach((fr) => {
                const count = Array.isArray(fr.landmarks)
                    ? fr.landmarks.length
                    : (fr.landmarks?.length ?? 0);
                const tr = document.createElement("tr");
                tr.innerHTML = `
          <td>${fr.num_frame}</td>
          <td>${count} puntos</td>
        `;
                detalleBody.appendChild(tr);
            });
            detalleInfo.textContent = `Mostrando ${rows.length} de ${data.secuencia.total_frames} frames.`;
        }
    } catch (e) {
        detalleBody.innerHTML = `<tr><td colspan="2" class="text-center text-danger py-3">Error cargando detalle</td></tr>`;
        console.error("Error detalle secuencia:", e);
        showToast("Error cargando detalle de la secuencia", "danger", 4000);
    }

    const modal = new bootstrap.Modal(document.getElementById("modalDetalle"));
    modal.show();
}

// ===== Edición =====
async function abrirModalEdicion(item) {
    await poblarCategoriasModal();

    document.getElementById("editSecuenciaId").value = item.id;
    document.getElementById("editNombre").value = item.nombre || "";
    const sel = document.getElementById("editCategoria");
    sel.value = item?.categoria?.slug || "";
    document.getElementById("editSubcategoria").value = item?.categoria?.subcategoria || "";

    const modalEl = document.getElementById("modalEditarSecuencia");
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();

    const btn = document.getElementById("btnGuardarEdicion");
    const nuevo = btn.cloneNode(true);
    btn.parentNode.replaceChild(nuevo, btn);

    nuevo.addEventListener("click", async () => {
        try {
            const id = Number(document.getElementById("editSecuenciaId").value);
            const payload = {
                nombre: document.getElementById("editNombre").value.trim(),
                categoria_slug: document.getElementById("editCategoria").value.trim(),
                subcategoria: document.getElementById("editSubcategoria").value.trim()
            };
            if (!payload.nombre) delete payload.nombre;
            if (!payload.categoria_slug) delete payload.categoria_slug;
            if (payload.subcategoria === "") payload.subcategoria = ""; // limpiar

            await patchSecuencia(id, payload);
            modal.hide();
            showToast("¡Cambios guardados! La secuencia fue actualizada.", "success", 2500);
            cargarHistorial();
        } catch (e) {
            console.error(e);
            showToast("No se pudo actualizar: " + (e?.message || e), "danger", 4000);
        }
    });
}

// ===== Eventos UI =====
function initHistorial() {
    document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => new bootstrap.Tooltip(el));

    document.getElementById("btnRefrescar")?.addEventListener("click", () => cargarHistorial());
    document.getElementById("prevPage")?.addEventListener("click", () => {
        if (pagina > 1) { pagina--; cargarHistorial(); }
    });
    document.getElementById("nextPage")?.addEventListener("click", () => { pagina++; cargarHistorial(); });
    document.getElementById("fTam")?.addEventListener("change", (e) => {
        tamanio = parseInt(e.target.value, 10) || 10;
        pagina = 1;
        cargarHistorial();
    });

    document.getElementById("formFiltros")?.addEventListener("submit", (e) => {
        e.preventDefault();
        pagina = 1;
        cargarHistorial();
    });
    document.getElementById("btnLimpiarNombre")?.addEventListener("click", () => {
        const el = document.getElementById("fNombre");
        if (el) el.value = "";
        pagina = 1;
        cargarHistorial();
    });
    document.getElementById("btnClearDesde")?.addEventListener("click", () => {
        const el = document.getElementById("fDesde");
        if (el) el.value = "";
        pagina = 1;
        cargarHistorial();
    });
    document.getElementById("btnClearHasta")?.addEventListener("click", () => {
        const el = document.getElementById("fHasta");
        if (el) el.value = "";
        pagina = 1;
        cargarHistorial();
    });
    document.getElementById("btnClearSubcat")?.addEventListener("click", () => {
        const el = document.getElementById("fSubcat");
        if (el) el.value = "";
        pagina = 1;
        cargarHistorial();
    });
    document.getElementById("fCategoria")?.addEventListener("change", () => {
        pagina = 1;
        cargarHistorial();
    });

    document.getElementById("fNombre")?.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => { pagina = 1; cargarHistorial(); }, 300);
    });
    const fSubcat = document.getElementById("fSubcat");
    if (fSubcat) {
        fSubcat.addEventListener("input", () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => { pagina = 1; cargarHistorial(); }, 300);
        });
    }

    poblarCategoriasFiltro().finally(() => {
        tamanio = parseInt(document.getElementById("fTam")?.value || "10", 10);
        cargarHistorial();
    });
}

// ===== Init =====
document.addEventListener("DOMContentLoaded", initHistorial);
