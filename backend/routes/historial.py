from flask import Blueprint, request, jsonify, Response
from bd.conexion import get_connection
from datetime import datetime, timedelta
import csv, io, json, re
from typing import Any, Tuple, Optional

historial_bp = Blueprint("historial_bp", __name__)

# =========================
# Utilidades (locales)
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
            return row[ idx_or_key ]
        raise KeyError(f"Índice requerido para fila tipo {type(row)}")
    if isinstance(row, dict):
        if isinstance(idx_or_key, str):
            return row.get(idx_or_key)
        raise KeyError(f"Clave requerida para fila tipo {type(row)}")
    return None

# -------------------------
# Normalización de nombres (para exponer tipo/valor)
# -------------------------
def _parse_normalized_nombre(nombre_norm: str) -> Tuple[str, str]:
    """Extrae (tipo, valor) desde el nombre normalizado."""
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
    return ("texto", nombre_norm)

# =========================
# GET /api/historial  (listado con filtros)
# =========================
@historial_bp.route("/historial", methods=["GET"])
def historial_listado():
    """
    GET /api/historial?nombre=&desde=&hasta=&pagina=1&tamanio=10&solo_con_frames=1
                         &categoria_slug=letra|numero|palabra|expresion_facial|saludo|otro
                         &subcategoria=A|5|hola|...
    """
    try:
        nombre = (request.args.get("nombre") or "").strip()
        desde = _parse_date_or_none(request.args.get("desde"))
        hasta = _parse_date_or_none(request.args.get("hasta"))
        solo_con_frames = request.args.get("solo_con_frames", "").lower() in ("1", "true")

        categoria_slug = (request.args.get("categoria_slug") or "").strip().lower()
        subcategoria   = (request.args.get("subcategoria") or "").strip()

        # hacer 'hasta' inclusivo si viene solo fecha
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

        joins = [
            "LEFT JOIN usuarios u ON u.id = s.usuario_id",
            "LEFT JOIN frames   f ON f.secuencia_id = s.id",
            "LEFT JOIN categorias c ON c.id = s.categoria_id"  # SIEMPRE unimos categorías
        ]

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
        if categoria_slug:
            where.append("c.slug = %s")
            params.append(categoria_slug)
        if subcategoria:
            where.append("s.subcategoria = %s")
            params.append(subcategoria)

        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        joins_sql = "\n".join(joins)

        # total
        if solo_con_frames:
            sql_total = f"""
                SELECT COUNT(*) AS total FROM (
                  SELECT s.id
                  FROM secuencias s
                  {joins_sql}
                  {where_sql}
                  GROUP BY s.id
                  HAVING COUNT(f.id) > 0
                ) t
            """
            total_params = params
        else:
            sql_total = f"""
                SELECT COUNT(*) AS total
                FROM secuencias s
                {joins_sql}
                {where_sql}
            """
            total_params = params

        having_sql = "HAVING COUNT(f.id) > 0" if solo_con_frames else ""
        sql_list = f"""
            SELECT
              s.id,
              s.nombre,
              s.fecha,
              s.usuario_id,
              COALESCE(u.usuario, u.nombre) AS usuario_nombre,
              COUNT(f.id) AS frames,
              s.subcategoria,
              c.slug AS categoria_slug,
              c.nombre AS categoria_nombre
            FROM secuencias s
            {joins_sql}
            {where_sql}
            GROUP BY s.id, s.nombre, s.fecha, s.usuario_id, u.usuario, u.nombre, s.subcategoria, c.slug, c.nombre
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
            sid  = _row_field(row, 0) if isinstance(row, (list, tuple)) else _row_field(row, "id")
            nom  = _row_field(row, 1) if isinstance(row, (list, tuple)) else _row_field(row, "nombre")
            fec  = _row_field(row, 2) if isinstance(row, (list, tuple)) else _row_field(row, "fecha")
            uid  = _row_field(row, 3) if isinstance(row, (list, tuple)) else _row_field(row, "usuario_id")
            unom = _row_field(row, 4) if isinstance(row, (list, tuple)) else _row_field(row, "usuario_nombre")
            frs  = _row_field(row, 5) if isinstance(row, (list, tuple)) else _row_field(row, "frames")
            subc = _row_field(row, 6) if isinstance(row, (list, tuple)) else _row_field(row, "subcategoria")
            cslg = _row_field(row, 7) if isinstance(row, (list, tuple)) else _row_field(row, "categoria_slug")
            cnom = _row_field(row, 8) if isinstance(row, (list, tuple)) else _row_field(row, "categoria_nombre")

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
                "categoria": {"slug": cslg, "nombre": cnom, "subcategoria": subc}
            })

        return jsonify({"ok": True, "pagina": pagina, "tamanio": tamanio, "total": int(total or 0), "items": items})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# =========================
# GET /api/historial/<id>  (detalle con frames)
# =========================
@historial_bp.route("/historial/<int:secuencia_id>", methods=["GET"])
def historial_detalle(secuencia_id: int):
    """GET /api/historial/<secuencia_id>?pagina=1&tamanio=200"""
    try:
        pagina = max(1, int(request.args.get("pagina", 1))) if request.args.get("pagina") else 1
        tamanio = min(1000, max(1, int(request.args.get("tamanio", 200)))) if request.args.get("tamanio") else 200
        offset = (pagina - 1) * tamanio

        sql_sec = """
            SELECT s.id, s.nombre, s.fecha,
                   COALESCE(u.usuario, u.nombre) AS usuario_nombre,
                   s.subcategoria, c.slug AS categoria_slug, c.nombre AS categoria_nombre
            FROM secuencias s
            LEFT JOIN usuarios u  ON u.id = s.usuario_id
            LEFT JOIN categorias c ON c.id = s.categoria_id
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
            s_sub = _row_field(row, 4) if isinstance(row, (list, tuple)) else _row_field(row, "subcategoria")
            s_csl = _row_field(row, 5) if isinstance(row, (list, tuple)) else _row_field(row, "categoria_slug")
            s_cno = _row_field(row, 6) if isinstance(row, (list, tuple)) else _row_field(row, "categoria_nombre")

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
                "frames": frames,
                "categoria": {"slug": s_csl, "nombre": s_cno, "subcategoria": s_sub}
            },
            "pagina": pagina,
            "tamanio": tamanio
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# =========================
# GET /api/exportar  (CSV/JSON con filtros, incluye categoría)
# =========================
@historial_bp.route("/exportar", methods=["GET"])
def exportar():
    """
    GET /api/exportar?formato=csv|json&secuencia_id=&nombre=&desde=&hasta=&categoria_slug=&subcategoria=
    """
    try:
        formato = (request.args.get("formato") or "csv").lower()
        secuencia_id = request.args.get("secuencia_id")
        nombre = (request.args.get("nombre") or "").strip()
        desde = _parse_date_or_none(request.args.get("desde"))
        hasta = _parse_date_or_none(request.args.get("hasta"))
        categoria_slug = (request.args.get("categoria_slug") or "").strip().lower()
        subcategoria   = (request.args.get("subcategoria") or "").strip()

        if hasta and hasta.hour == 0 and hasta.minute == 0 and hasta.second == 0 and hasta.microsecond == 0:
            hasta = hasta + timedelta(days=1) - timedelta(microseconds=1)

        joins = ["JOIN frames f ON f.secuencia_id = s.id",
                 "LEFT JOIN categorias c ON c.id = s.categoria_id"]

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
        if categoria_slug:
            where.append("c.slug = %s")
            params.append(categoria_slug)
        if subcategoria:
            where.append("s.subcategoria = %s")
            params.append(subcategoria)

        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        joins_sql = "\n".join(joins)

        sql = f"""
            SELECT s.nombre AS nombre_secuencia,
                   s.fecha,
                   f.num_frame,
                   f.landmarks,
                   c.slug  AS categoria_slug,
                   s.subcategoria
            FROM secuencias s
            {joins_sql}
            {where_sql}
            ORDER BY s.fecha DESC, f.num_frame ASC
        """

        with get_connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()

        registros = []
        for r in rows:
            if isinstance(r, (list, tuple)):
                nombre_s, fecha, num_frame, landmarks, cat_slug, subcat = r
            else:
                nombre_s = r.get("nombre_secuencia")
                fecha = r.get("fecha")
                num_frame = r.get("num_frame")
                landmarks = r.get("landmarks")
                cat_slug = r.get("categoria_slug")
                subcat = r.get("subcategoria")
            tipo, valor = _parse_normalized_nombre(nombre_s or "")
            registros.append({
                "nombre_secuencia": nombre_s,
                "tipo": tipo,
                "valor": valor,
                "fecha": fecha.isoformat() if hasattr(fecha, "isoformat") else (str(fecha) if fecha else None),
                "num_frame": int(num_frame or 0),
                "landmarks": landmarks,
                "categoria_slug": cat_slug,
                "subcategoria": subcat
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
        writer.writerow(["nombre_secuencia", "tipo", "valor", "fecha", "num_frame", "categoria_slug", "subcategoria", "landmarks_json"])
        for item in registros:
            writer.writerow([
                item["nombre_secuencia"],
                item["tipo"],
                item["valor"],
                item["fecha"],
                item["num_frame"],
                item["categoria_slug"] or "",
                item["subcategoria"] or "",
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
