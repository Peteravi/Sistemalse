// ===== Config =====
const BACKEND_URL = "https://lse-backend-479238723367.us-central1.run.app";

// ===== Estado =====
let pagina = 1;
let tamanio = 10;
let debounceTimer = null;
let filtroInicialAplicado = false;

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
        const res = await fetch(`${BACKEND_URL}/api/historial?${params.toString()}`, {
            credentials: "include",
            cache: "no-store",
        });

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { throw new Error("Respuesta no válida del servidor"); }

        tbody.innerHTML = "";
        if (!data.ok || !Array.isArray(data.items) || data.items.length === 0) {
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
          <button class="btn btn-sm btn-outline-info" data-id="${item.id}">
            <i class="bi bi-eye"></i> Ver
          </button>
        </td>
      `;
            tr.querySelector("button").addEventListener("click", () =>
                verDetalle(item.id, item.nombre, item.fecha, item.frames, item.usuario)
            );
            tbody.appendChild(tr);
        });

        const inicio = (pagina - 1) * tamanio + 1;
        const fin = inicio + data.items.length - 1;
        document.getElementById("histInfo").textContent = `Mostrando ${inicio}-${fin} de ${data.total}`;
        document.getElementById("prevPage").disabled = pagina <= 1;
        document.getElementById("nextPage").disabled = pagina * tamanio >= data.total;
    } catch (e) {
        setError(tbody);
        console.error("Error cargando historial:", e);
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
        const res = await fetch(`${BACKEND_URL}/api/historial/${id}?pagina=1&tamanio=200`, {
            credentials: "include",
            cache: "no-store",
        });

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { throw new Error("Respuesta no válida del servidor"); }
        if (!data.ok) throw new Error(data.error || "Error");

        // Actualiza meta con categoría/subcategoría del detalle si existen
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
    }

    const modal = new bootstrap.Modal(document.getElementById("modalDetalle"));
    modal.show();
}

// ===== Eventos UI =====
function initHistorial() {
    // Controles
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

    // Filtros (submit + botones limpiar)
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
    document.getElementById("fCategoria")?.addEventListener("change", () => {
        pagina = 1;
        cargarHistorial();
    });

    // NUEVO: Debounce para subcategoría (igual que nombre)
    const fSubcat = document.getElementById("fSubcat");
    if (fSubcat) {
        fSubcat.addEventListener("input", () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => { pagina = 1; cargarHistorial(); }, 300);
        });
    }

    // Debounce al teclear en nombre
    document.getElementById("fNombre")?.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => { pagina = 1; cargarHistorial(); }, 300);
    });

    // Carga inicial: tamanio y filtro auto
    tamanio = parseInt(document.getElementById("fTam")?.value || "10", 10);
    cargarHistorial();
}

// ===== Init =====
document.addEventListener("DOMContentLoaded", initHistorial);
