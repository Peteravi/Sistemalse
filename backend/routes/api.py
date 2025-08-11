from flask import Blueprint, request, jsonify, Response
from bd.conexion import get_connection
from datetime import datetime, timedelta
import csv, io, json, re
from typing import Any, Tuple, Optional

api_bp = Blueprint("api_bp", __name__)

# =========================
# Utilidades
# =========================
def _parse_date_or_none(s: str | None):
    """Acepta 'YYYY-MM-DD' o ISO completo. Devuelve datetime o None."""
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
    """Obtiene un campo de una fila (tupla/dict) por índice o clave."""
    if isinstance(row, (list, tuple)):
        if isinstance(idx_or_key, int):
            return row[idx_or_key]
        raise KeyError(f"Índice requerido para fila tipo {type(row)}")
    if isinstance(row, dict):
        if isinstance(idx_or_key, str):
            return row.get(idx_or_key)
        raise KeyError(f"Clave requerida para fila tipo {type(row)}")
    return None

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
    Reglas:
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
        # aceptamos YYYY-MM-DD
        try:
            dt = _parse_date_or_none(valor)
            if dt:
                y, m, d = dt.date().isoformat().split("-")
                return (f"FECHA:{y}-{m}-{d}", "fecha", f"{y}-{m}-{d}")
        except:
            pass
    elif tipo == "cantidad":
        # decimal con punto
        try:
            v = float(valor.replace(",", "."))
            return (f"CANT:{v}", "cantidad", str(v))
        except:
            pass

    # 2) Intentar inferir desde 'raw'
    if raw:
        # ¿número 1..100?
        m = NUM_RE.match(raw)
        if m:
            try:
                n = int(m.group(1))
                if 1 <= n <= 100:
                    return (f"NUM:{n}", "numero", str(n))
            except:
                pass
        # ¿fecha YYYY-MM-DD?
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
        # ¿cantidad decimal?
        m = CANT_RE.match(raw)
        if m:
            try:
                v = float(m.group(1).replace(",", "."))
                return (f"CANT:{v}", "cantidad", str(v))
            except:
                pass
        # fallback texto
        return (f"TEXTO:{raw}", "texto", raw)

    # 3) último recurso
    return ("TEXTO:", "texto", "")

def _parse_normalized_nombre(nombre_norm: str) -> Tuple[str, str]:
    """
    Extrae (tipo, valor) desde el nombre normalizado.
    """
    if not nombre_norm:
        return ("texto", "")
    if nombre_norm.startswith("NUM:"):
        return ("numero", nombre_norm[4:])
    if nombre_norm.startswith("FECHA:"):
        return ("fecha", nombre_norm[6:])
    if nombre_norm.startswith("CANT:"):
        return ("cantidad", nombre_norm[5:])
    if nombre_norm.startswith("TEXTO:"):
        return ("texto", nombre_norm[6:])
    # Desconocido -> texto
    return ("texto", nombre_norm)

# =========================
# Crear secuencia
# =========================
@api_bp.route("/crear_secuencia", methods=["POST"])
def crear_secuencia():
    """
    Body JSON:
      Opción clásica: { "nombre": "hola" }
      Nuevos campos (opc): { "tipo": "numero|fecha|cantidad|texto", "valor": "..." }
    """
    try:
        data = request.get_json(silent=True) or {}
        nombre = (data.get("nombre") or "").strip()
        tipo   = (data.get("tipo") or "").strip().lower() or None
        valor  = (data.get("valor") or "").strip() or None

        if not nombre and not valor:
            return jsonify({"ok": False, "error": "Se requiere 'nombre' o ('tipo' y 'valor')"}), 400

        nombre_norm, tipo_final, valor_final = _build_normalized_nombre(tipo, valor, nombre)

        usuario_id = data.get("usuario_id")
        fecha = _parse_date_or_none(data.get("fecha")) or datetime.utcnow()

        with get_connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO secuencias (nombre, fecha, usuario_id) VALUES (%s, %s, %s) RETURNING id",
                (nombre_norm, fecha, usuario_id),
            )
            row = cur.fetchone()
            secuencia_id = _get_one_value(row, None)
            conn.commit()

        return jsonify({
            "ok": True,
            "secuencia_id": secuencia_id,
            "nombre": nombre_norm,
            "tipo": tipo_final,
            "valor": valor_final
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# =========================
# Guardar frame (usa num_frame y JSONB)
# =========================
@api_bp.route("/guardar_frame", methods=["POST"])
def guardar_frame():
    """
    Body JSON:
    {
      "secuencia_id": 123  ó  ("etiqueta"/"nombre" o "tipo"+"valor"),
      "frame": 0,                            # -> num_frame
      "landmarks": [ {x:..., y:..., z:...}, ... ]
    }
    """
    try:
        data = request.get_json(silent=True) or {}

        secuencia_id = data.get("secuencia_id")
        etiqueta = (data.get("etiqueta") or data.get("nombre") or "").strip()
        tipo  = (data.get("tipo") or "").strip().lower() or None
        valor = (data.get("valor") or "").strip() or None

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
                nombre_norm, _, _ = _build_normalized_nombre(tipo, valor, etiqueta)
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

# =========================
# Historial (listado)
# =========================
@api_bp.route("/historial", methods=["GET"])
def historial_listado():
    """
    GET /api/historial?nombre=&desde=&hasta=&pagina=1&tamanio=10&solo_con_frames=1
    """
    try:
        nombre = (request.args.get("nombre") or "").strip()
        desde = _parse_date_or_none(request.args.get("desde"))
        hasta = _parse_date_or_none(request.args.get("hasta"))
        solo_con_frames = request.args.get("solo_con_frames", "").lower() in ("1", "true")

        # Hacer 'hasta' inclusivo si viene solo fecha
        if hasta and hasta.hour == 0 and hasta.minute == 0 and hasta.second == 0 and hasta.microsecond == 0:
            hasta = hasta + timedelta(days=1) - timedelta(microseconds=1)

        try:
            pagina = max(1, int(request.args.get("pagina", 1)))
        except:
            pagina = 1
        try:
            tamanio = min(100, max(1, int(request.args.get("tamanio", 20))))
        except:
            tamanio = 20
        offset = (pagina - 1) * tamanio

        where = []
        params = []
        if nombre:
            where.append("s.nombre ILIKE %s")
            params.append(f"%{nombre}%")
        if desde:
            where.append("s.fecha >= %s")
            params.append(desde)
        if hasta:
            where.append("s.fecha <= %s")
            params.append(hasta)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        # total
        if solo_con_frames:
            sql_total = f"""
                SELECT COUNT(*) AS total FROM (
                  SELECT s.id
                  FROM secuencias s
                  LEFT JOIN frames f ON f.secuencia_id = s.id
                  {where_sql}
                  GROUP BY s.id
                  HAVING COUNT(f.id) > 0
                ) t
            """
            total_params = params
        else:
            sql_total = f"SELECT COUNT(*) AS total FROM secuencias s {where_sql}"
            total_params = params

        having_sql = "HAVING COUNT(f.id) > 0" if solo_con_frames else ""
        sql_list = f"""
            SELECT
              s.id,
              s.nombre,
              s.fecha,
              s.usuario_id,
              COALESCE(u.usuario, u.nombre) AS usuario_nombre,
              COUNT(f.id) AS frames
            FROM secuencias s
            LEFT JOIN usuarios u ON u.id = s.usuario_id
            LEFT JOIN frames   f ON f.secuencia_id = s.id
            {where_sql}
            GROUP BY s.id, s.nombre, s.fecha, s.usuario_id, u.usuario, u.nombre
            {having_sql}
            ORDER BY s.fecha DESC
            LIMIT %s OFFSET %s
        """

        with get_connection() as conn, conn.cursor() as cur:
            cur.execute(sql_total, total_params)
            total = _get_one_value(cur.fetchone(), 0)

            cur.execute(sql_list, params + [tamanio, offset])
            rows = cur.fetchall()

        items = []
        for row in rows:
            sid = _row_field(row, 0) if isinstance(row, (list, tuple)) else _row_field(row, "id")
            nom = _row_field(row, 1) if isinstance(row, (list, tuple)) else _row_field(row, "nombre")
            fec = _row_field(row, 2) if isinstance(row, (list, tuple)) else _row_field(row, "fecha")
            uid = _row_field(row, 3) if isinstance(row, (list, tuple)) else _row_field(row, "usuario_id")
            unom = _row_field(row, 4) if isinstance(row, (list, tuple)) else _row_field(row, "usuario_nombre")
            frs = _row_field(row, 5) if isinstance(row, (list, tuple)) else _row_field(row, "frames")

            tipo, valor = _parse_normalized_nombre(nom or "")
            items.append({
                "id": sid,
                "nombre": nom,
                "tipo": tipo,
                "valor": valor,
                "fecha": fec.isoformat() if hasattr(fec, "isoformat") else (str(fec) if fec else None),
                "usuario_id": uid,
                "usuario": unom,
                "frames": int(frs or 0),
            })

        return jsonify({"ok": True, "pagina": pagina, "tamanio": tamanio, "total": int(total or 0), "items": items})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# =========================
# Historial (detalle)
# =========================
@api_bp.route("/historial/<int:secuencia_id>", methods=["GET"])
def historial_detalle(secuencia_id: int):
    """GET /api/historial/<secuencia_id>?pagina=1&tamanio=200"""
    try:
        pagina = max(1, int(request.args.get("pagina", 1))) if request.args.get("pagina") else 1
        tamanio = min(1000, max(1, int(request.args.get("tamanio", 200)))) if request.args.get("tamanio") else 200
        offset = (pagina - 1) * tamanio

        sql_sec = """
            SELECT s.id, s.nombre, s.fecha,
                   COALESCE(u.usuario, u.nombre) AS usuario_nombre
            FROM secuencias s
            LEFT JOIN usuarios u ON u.id = s.usuario_id
            WHERE s.id = %s
        """
        sql_total = "SELECT COUNT(*) AS total FROM frames WHERE secuencia_id = %s"
        sql_frames = """
            SELECT id, num_frame, landmarks
            FROM frames
            WHERE secuencia_id = %s
            ORDER BY num_frame ASC
            LIMIT %s OFFSET %s
        """

        with get_connection() as conn, conn.cursor() as cur:
            cur.execute(sql_sec, (secuencia_id,))
            row = cur.fetchone()
            if not row:
                return jsonify({"ok": False, "error": "Secuencia no encontrada"}), 404

            s_id  = _row_field(row, 0) if isinstance(row, (list, tuple)) else _row_field(row, "id")
            s_nom = _row_field(row, 1) if isinstance(row, (list, tuple)) else _row_field(row, "nombre")
            s_fec = _row_field(row, 2) if isinstance(row, (list, tuple)) else _row_field(row, "fecha")
            s_usr = _row_field(row, 3) if isinstance(row, (list, tuple)) else _row_field(row, "usuario_nombre")

            cur.execute(sql_total, (secuencia_id,))
            total_frames = _get_one_value(cur.fetchone(), 0)

            cur.execute(sql_frames, (secuencia_id, tamanio, offset))
            rows = cur.fetchall()

        frames = []
        for r in rows:
            f_id = _row_field(r, 0) if isinstance(r, (list, tuple)) else _row_field(r, "id")
            nf   = _row_field(r, 1) if isinstance(r, (list, tuple)) else _row_field(r, "num_frame")
            lmk  = _row_field(r, 2) if isinstance(r, (list, tuple)) else _row_field(r, "landmarks")
            frames.append({"id": f_id, "frame": nf, "num_frame": nf, "landmarks": lmk})

        fecha_iso = s_fec.isoformat() if hasattr(s_fec, "isoformat") else (str(s_fec) if s_fec else None)
        tipo, valor = _parse_normalized_nombre(s_nom or "")

        return jsonify({
            "ok": True,
            "secuencia": {
                "id": s_id,
                "nombre": s_nom,
                "tipo": tipo,
                "valor": valor,
                "fecha": fecha_iso,
                "usuario": s_usr,
                "total_frames": int(total_frames or 0),
                "frames": frames
            },
            "pagina": pagina,
            "tamanio": tamanio
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# =========================
# Exportación CSV / JSON
# =========================
@api_bp.route("/exportar", methods=["GET"])
def exportar():
    """
    GET /api/exportar?formato=csv|json&secuencia_id=&nombre=&desde=&hasta=
    """
    try:
        formato = (request.args.get("formato") or "csv").lower()
        secuencia_id = request.args.get("secuencia_id")
        nombre = (request.args.get("nombre") or "").strip()
        desde = _parse_date_or_none(request.args.get("desde"))
        hasta = _parse_date_or_none(request.args.get("hasta"))

        if hasta and hasta.hour == 0 and hasta.minute == 0 and hasta.second == 0 and hasta.microsecond == 0:
            hasta = hasta + timedelta(days=1) - timedelta(microseconds=1)

        where = []
        params = []
        if secuencia_id:
            where.append("s.id = %s")
            params.append(int(secuencia_id))
        if nombre:
            where.append("s.nombre ILIKE %s")
            params.append(f"%{nombre}%")
        if desde:
            where.append("s.fecha >= %s")
            params.append(desde)
        if hasta:
            where.append("s.fecha <= %s")
            params.append(hasta)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        sql = f"""
            SELECT s.nombre AS nombre_secuencia,
                   s.fecha,
                   f.num_frame,
                   f.landmarks
            FROM secuencias s
            JOIN frames f ON f.secuencia_id = s.id
            {where_sql}
            ORDER BY s.fecha DESC, f.num_frame ASC
        """

        with get_connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()

        registros = []
        for r in rows:
            if isinstance(r, (list, tuple)):
                nombre_s, fecha, num_frame, landmarks = r
            else:
                nombre_s = r.get("nombre_secuencia")
                fecha = r.get("fecha")
                num_frame = r.get("num_frame")
                landmarks = r.get("landmarks")
            tipo, valor = _parse_normalized_nombre(nombre_s or "")
            registros.append({
                "nombre_secuencia": nombre_s,
                "tipo": tipo,
                "valor": valor,
                "fecha": fecha.isoformat() if hasattr(fecha, "isoformat") else (str(fecha) if fecha else None),
                "num_frame": int(num_frame or 0),
                "landmarks": landmarks
            })

        if formato == "json":
            return Response(
                json.dumps(registros, ensure_ascii=False),
                mimetype="application/json",
                headers={"Content-Disposition": 'attachment; filename="export_lse.json"'}
            )

        # CSV por defecto: guardamos landmarks como JSON string
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["nombre_secuencia", "tipo", "valor", "fecha", "num_frame", "landmarks_json"])
        for item in registros:
            writer.writerow([
                item["nombre_secuencia"],
                item["tipo"],
                item["valor"],
                item["fecha"],
                item["num_frame"],
                json.dumps(item["landmarks"], ensure_ascii=False)
            ])
        csv_data = output.getvalue()

        return Response(
            csv_data,
            mimetype="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="export_lse.csv"'}
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
