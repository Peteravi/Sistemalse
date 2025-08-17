from flask import Blueprint, request, jsonify
from bd.conexion import get_connection
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import json, re
from typing import Any, Tuple, Optional

api_bp = Blueprint("api_bp", __name__)

# =========================
# Utilidades
# =========================
def _parse_date_or_none(s: str | None):
    """Acepta 'YYYY-MM-DD' o ISO completo. Devuelve datetime o None (naive/aware)."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        try:
            return datetime.strptime(s, "%Y-%m-%d")
        except Exception:
            return None

def _get_one_value(row: Any, default=0):
    """Obtiene el primer valor de una fila, funcione si es tupla/lista o dict."""
    if row is None:
        return default
    if isinstance(row, (list, tuple)):
        return row[0] if row else default
    if isinstance(row, dict):
        for v in row.values():
            return v
    return default

def _row_field(row: Any, idx_or_key):
    """Obtiene un campo de una fila (tupla/dict) por índice o clave.
       Soporta:
         - tuplas/listas con índice int
         - dict con clave str
         - dict con índice int (usa el orden de columnas devuelto por el cursor)
    """
    if row is None:
        raise KeyError("Fila vacía")
    # Tupla/lista -> índice
    if isinstance(row, (list, tuple)):
        if isinstance(idx_or_key, int):
            return row[idx_or_key]
        raise KeyError(f"Índice requerido para fila tipo {type(row)}")
    # Dict -> clave o índice por posición
    if isinstance(row, dict):
        if isinstance(idx_or_key, str):
            return row.get(idx_or_key)
        if isinstance(idx_or_key, int):
            vals = list(row.values())
            if 0 <= idx_or_key < len(vals):
                return vals[idx_or_key]
            raise KeyError(f"Índice fuera de rango para fila dict (len={len(vals)})")
        raise KeyError(f"Clave o índice requerido para fila tipo {type(row)}")
    raise KeyError(f"Tipo de fila no soportado: {type(row)}")

def _iso_utc_z(dt):
    """
    Devuelve ISO-8601 en UTC con sufijo 'Z'.
    - Si dt viene naive, lo interpretamos como UTC (compatibilidad con datos antiguos).
    """
    if not dt:
        return None
    try:
        if getattr(dt, "tzinfo", None) is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")
    except Exception:
        return str(dt)

# -------------------------
# Normalización de nombres
# -------------------------
# Formatos normalizados:
#   NUM:<int>      -> 1..100
#   FECHA:<yyyy-mm-dd>
#   CANT:<numero>  -> admite decimales
#   TEXTO:<string> -> fallback si no se reconoce
NUM_RE = re.compile(r"^\s*(\d{1,3})\s*$")
FECHA_RE = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})\s*$")
CANT_RE = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(?:unid(?:ades)?|u|pcs|kg|g|l|ml)?\s*$", re.IGNORECASE)

def _build_normalized_nombre(tipo: Optional[str], valor: Optional[str], nombre: Optional[str]) -> Tuple[str, str, str]:
    """
    Devuelve (nombre_normalizado, tipo_final, valor_final)
      - Si viene tipo/valor válidos, se priorizan.
      - Si no, se infiere desde 'nombre'.
    """
    tipo = (tipo or "").strip().lower()
    valor = (valor or "").strip()
    raw = (nombre or "").strip()

    # 1) Si nos dieron tipo+valor válidos
    if tipo == "numero":
        try:
            n = int(valor)
            if 1 <= n <= 100:
                return (f"NUM:{n}", "numero", str(n))
        except:
            pass
    elif tipo == "fecha":
        try:
            dt = _parse_date_or_none(valor)
            if dt:
                y, m, d = dt.date().isoformat().split("-")
                return (f"FECHA:{y}-{m}-{d}", "fecha", f"{y}-{m}-{d}")
        except:
            pass
    elif tipo == "cantidad":
        try:
            v = float(valor.replace(",", "."))
            return (f"CANT:{v}", "cantidad", str(v))
        except:
            pass

    # 2) Inferir desde 'raw'
    if raw:
        m = NUM_RE.match(raw)
        if m:
            try:
                n = int(m.group(1))
                if 1 <= n <= 100:
                    return (f"NUM:{n}", "numero", str(n))
            except:
                pass
        m = FECHA_RE.match(raw)
        if m:
            try:
                y, mo, d = m.groups()
                dt = _parse_date_or_none(f"{y}-{mo}-{d}")
                if dt:
                    y, mo, d = dt.date().isoformat().split("-")
                    return (f"FECHA:{y}-{mo}-{d}", "fecha", f"{y}-{mo}-{d}")
            except:
                pass
        m = CANT_RE.match(raw)
        if m:
            try:
                v = float(m.group(1).replace(",", "."))
                return (f"CANT:{v}", "cantidad", str(v))
            except:
                pass
        return (f"TEXTO:{raw}", "texto", raw)

    # 3) Último recurso
    return ("TEXTO:", "texto", "")

# ===== Helpers de categoría =====
def _infer_categoria_y_subcategoria(nombre_norm: str, tipo_final: str | None, valor_final: str | None) -> tuple[str, str | None]:
    """
    Reglas simples:
      - Una sola letra A-Z/Ñ -> ('letra', 'A')
      - Un solo dígito 0-9   -> ('numero', '0')
      - Palabras de saludo   -> ('saludo','hola')
      - 'tipo' numero/fecha/cantidad guía la categoría
      - Por defecto -> 'palabra' si es palabra corta, si no 'otro'
    """
    n = (nombre_norm or "").strip()
    if tipo_final in {"numero", "cantidad"}:
        if valor_final and re.fullmatch(r"\d+", str(valor_final)):
            return ("numero", str(valor_final))
        if re.fullmatch(r"\d", n):
            return ("numero", n)
        return ("numero", None)
    if tipo_final == "fecha":
        return ("otro", None)

    if re.fullmatch(r"[A-Za-zÁÉÍÓÚÑáéíóúñ]", n):
        return ("letra", n.upper())
    if re.fullmatch(r"\d", n):
        return ("numero", n)

    lower = n.lower()
    if lower in {"hola", "adios", "buenos dias", "buenas tardes", "buenas noches"}:
        return ("saludo", lower)
    if lower in {"gracias", "por favor", "ayuda", "si", "no"}:
        return ("palabra", lower)

    if re.fullmatch(r"[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,12}", n):
        return ("palabra", lower)

    return ("otro", None)

def _categoria_id_por_slug(cur, slug: str | None) -> int | None:
    """Obtiene id de categoría por slug (tolera cursor tupla o dict)."""
    if not slug:
        return None
    cur.execute("SELECT id FROM categorias WHERE slug=%s", (slug,))
    r = cur.fetchone()
    if not r:
        return None
    return _row_field(r, 0) if isinstance(r, (list, tuple)) else _row_field(r, "id")

# =========================
# POST /api/crear_secuencia
# =========================
@api_bp.route("/crear_secuencia", methods=["POST"])
def crear_secuencia():
    try:
        data = request.get_json(silent=True) or {}

        nombre_in = (data.get("nombre") or "").strip()
        tipo_in   = (data.get("tipo") or "").strip().lower() or None
        valor_in  = (data.get("valor") or "").strip() or None

        categoria_slug = (data.get("categoria_slug") or "").strip().lower() or None
        subcategoria   = (data.get("subcategoria") or "").strip() or None
        usuario_id     = data.get("usuario_id")  # opcional

        # === Fecha: normalizar a UTC-aware ===
        fecha = _parse_date_or_none(data.get("fecha"))
        if fecha is None:
            # Sin fecha -> ahora en UTC (aware)
            fecha = datetime.now(timezone.utc)
        else:
            # Si vino naive, asumir hora local de Guayaquil para convertir a UTC
            if fecha.tzinfo is None:
                fecha = fecha.replace(tzinfo=ZoneInfo("America/Guayaquil"))
            fecha = fecha.astimezone(timezone.utc)

        if not nombre_in and not valor_in:
            return jsonify({"ok": False, "error": "Se requiere 'nombre' o ('tipo' y 'valor')"}), 400

        nombre_norm, tipo_final, valor_final = _build_normalized_nombre(tipo_in, valor_in, nombre_in)

        with get_connection() as conn, conn.cursor() as cur:
            # Inferir categoría si no viene
            try:
                if not categoria_slug:
                    categoria_slug, sub_inf = _infer_categoria_y_subcategoria(nombre_norm, tipo_final, valor_final)
                    if not subcategoria and sub_inf:
                        subcategoria = sub_inf
            except Exception:
                categoria_slug = None

            categoria_id = None
            if categoria_slug:
                try:
                    categoria_id = _categoria_id_por_slug(cur, categoria_slug)
                    if categoria_id is None:
                        categoria_id = _categoria_id_por_slug(cur, "otro")
                except Exception:
                    categoria_id = None

            # Insert principal (con categoría + fecha aware)
            try:
                cur.execute("""
                    INSERT INTO secuencias (nombre, fecha, usuario_id, categoria_id, subcategoria)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING id, fecha, categoria_id, subcategoria
                """, (nombre_norm, fecha, usuario_id, categoria_id, subcategoria))
                row = cur.fetchone()
                secuencia_id    = _row_field(row, 0)
                fecha_db        = _row_field(row, 1)
                categoria_id_db = _row_field(row, 2)
                subcategoria_db = _row_field(row, 3)
            except Exception:
                # Fallback esquema viejo (sin columnas de categoría)
                cur.execute("""
                    INSERT INTO secuencias (nombre, fecha, usuario_id)
                    VALUES (%s, %s, %s)
                    RETURNING id, fecha
                """, (nombre_norm, fecha, usuario_id))
                row = cur.fetchone()
                secuencia_id    = _row_field(row, 0)
                fecha_db        = _row_field(row, 1)
                categoria_id_db = None
                subcategoria_db = None

            # Enriquecer categoría
            cat_slug_resp = cat_nombre_resp = None
            if categoria_id_db:
                try:
                    cur.execute("SELECT slug, nombre FROM categorias WHERE id=%s", (categoria_id_db,))
                    r = cur.fetchone()
                    cat_slug_resp   = _row_field(r, 0)
                    cat_nombre_resp = _row_field(r, 1)
                except Exception:
                    pass

            conn.commit()
            return jsonify({
                "ok": True,
                "secuencia_id": secuencia_id,
                "nombre": nombre_norm,
                "tipo": tipo_final,
                "valor": valor_final,
                "categoria": {
                    "id": categoria_id_db,
                    "slug": cat_slug_resp,
                    "nombre": cat_nombre_resp,
                    "subcategoria": subcategoria_db
                },
                "fecha": _iso_utc_z(fecha_db)
            })

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# =========================
# POST /api/guardar_frame
# =========================
@api_bp.route("/guardar_frame", methods=["POST"])
def guardar_frame():
    """
    Body JSON:
    {
      "secuencia_id": 123  ó  ("etiqueta"/"nombre" o "tipo"+"valor"),
      "frame": 0,                            # -> num_frame
      "landmarks": [ {x:..., y:..., z:...}, ... ],
      "categoria_slug": "letra|numero|palabra|expresion_facial|saludo|otro",  # opcional
      "subcategoria": "A|0|hola|...",                                        # opcional
      "usuario_id": 1                                                         # opcional
    }
    """
    try:
        data = request.get_json(silent=True) or {}

        secuencia_id = data.get("secuencia_id")
        etiqueta = (data.get("etiqueta") or data.get("nombre") or "").strip()
        tipo  = (data.get("tipo") or "").strip().lower() or None
        valor = (data.get("valor") or "").strip() or None

        categoria_slug = (data.get("categoria_slug") or "").strip().lower() or None
        subcategoria   = (data.get("subcategoria") or "").strip() or None
        usuario_id     = data.get("usuario_id")

        # Normaliza frame -> num_frame
        try:
            num_frame = int(data.get("frame", 0))
            if num_frame < 0:
                num_frame = 0
        except Exception:
            num_frame = 0

        landmarks = data.get("landmarks", [])

        # -------- Validaciones fuertes de landmarks --------
        if isinstance(landmarks, dict):
            landmarks = [landmarks]

        if not isinstance(landmarks, list) or len(landmarks) == 0:
            return jsonify({"ok": False, "error": "landmarks vacíos o inválidos"}), 400

        def _p_ok(p):
            if not isinstance(p, dict):
                return False
            if not all(k in p for k in ("x", "y", "z")):
                return False
            try:
                float(p["x"]); float(p["y"]); float(p["z"])
            except Exception:
                return False
            return True

        if not all(_p_ok(p) for p in landmarks):
            return jsonify({"ok": False, "error": "formato de landmarks inválido; se requieren campos numéricos x,y,z"}), 400
        # ---------------------------------------------------

        if not secuencia_id and not etiqueta and not valor:
            return jsonify({"ok": False, "error": "secuencia_id o (nombre/tipo+valor) requerido"}), 400

        with get_connection() as conn, conn.cursor() as cur:
            # Crear secuencia si no se envió secuencia_id
            if not secuencia_id:
                nombre_norm, tipo_final, valor_final = _build_normalized_nombre(tipo, valor, etiqueta)
                # Inferir categoría si no la mandaron
                try:
                    if not categoria_slug:
                        categoria_slug, sub_inf = _infer_categoria_y_subcategoria(nombre_norm, tipo_final, valor_final)
                        if not subcategoria and sub_inf:
                            subcategoria = sub_inf
                except Exception:
                    categoria_slug = None

                # Resolver categoria_id (tolerante)
                categoria_id = None
                if categoria_slug:
                    try:
                        categoria_id = _categoria_id_por_slug(cur, categoria_slug)
                        if categoria_id is None:
                            categoria_id = _categoria_id_por_slug(cur, "otro")
                    except Exception:
                        categoria_id = None

                # Intento con columnas de categoría
                try:
                    cur.execute("""
                        INSERT INTO secuencias (nombre, fecha, usuario_id, categoria_id, subcategoria)
                        VALUES (%s, NOW(), %s, %s, %s)
                        RETURNING id
                    """, (nombre_norm, usuario_id, categoria_id, subcategoria))
                    row = cur.fetchone()
                    secuencia_id = _get_one_value(row, None)
                except Exception:
                    # Fallback a esquema viejo (sin columnas de categoría)
                    cur.execute(
                        "INSERT INTO secuencias (nombre) VALUES (%s) RETURNING id",
                        (nombre_norm,)
                    )
                    row = cur.fetchone()
                    secuencia_id = _get_one_value(row, None)

                if not secuencia_id:
                    return jsonify({"ok": False, "error": "no se pudo crear la secuencia"}), 500

            # Insertar frame con num_frame y landmarks (JSONB)
            cur.execute(
                "INSERT INTO frames (secuencia_id, num_frame, landmarks) VALUES (%s, %s, %s) RETURNING id",
                (secuencia_id, num_frame, json.dumps(landmarks, ensure_ascii=False))
            )
            fid_row = cur.fetchone()
            conn.commit()

        fid = _get_one_value(fid_row, None)
        return jsonify({"ok": True, "id": fid, "secuencia_id": secuencia_id, "num_frame": num_frame})

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
