# backend/routes/metricas.py
from flask import Blueprint, request, jsonify
from bd.conexion import get_connection
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from psycopg2.extras import RealDictCursor

metricas_bp = Blueprint("metricas_bp", __name__)

LOCAL_TZ = ZoneInfo("America/Guayaquil")

def _parse_date_or_none(s: str | None):
    """Acepta YYYY-MM-DD o ISO 8601 (con/sin Z). Devuelve datetime (naive/aware) o None."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        try:
            return datetime.strptime(s, "%Y-%m-%d")
        except Exception:
            return None

def _iso_utc_z(dt):
    """Devuelve ISO en UTC con sufijo Z o None."""
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

@metricas_bp.route("/metrics/overview", methods=["OPTIONS"])
def metrics_overview_preflight():
    # 204 sin cuerpo: las cabeceras CORS globales se añaden en app.after_request
    return ("", 204)

@metricas_bp.route("/metrics/overview", methods=["GET"])
def overview():
    """
    GET /api/metrics/overview?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&fps=30&usuario_id=&categoria_slug=
    Devuelve:
    {
      rango: {desde, hasta},
      totales: {secuencias, frames},
      promedios: {frames_por_secuencia, frame_span, duracion_estimada_seg, fps_asumido},
      series: {
        secuencias_por_dia: [{dia, total}],
        frames_por_dia: [{dia, total}]
      },
      categorias: [{slug, subcategoria, total}],
      usuarios: [{usuario_id, total}],
      horas: [{hora_0_23, total}]
    }
    """
    # --- Parámetros ---
    desde = _parse_date_or_none(request.args.get("desde"))
    hasta = _parse_date_or_none(request.args.get("hasta"))
    try:
        fps = float(request.args.get("fps", 30))
        if fps <= 0:
            fps = 30.0
    except Exception:
        fps = 30.0

    usuario_id = request.args.get("usuario_id")
    categoria_slug = (request.args.get("categoria_slug") or "").strip().lower()

    filtros = []
    params = []

    # secuencias.fecha se almacena en UTC
    if desde:
        # Asegura comparar en UTC
        d = desde
        if d.tzinfo is None:
            d = d.replace(tzinfo=LOCAL_TZ)
        filtros.append("s.fecha >= %s")
        params.append(d.astimezone(timezone.utc))

    if hasta:
        # si viene solo fecha (00:00:00), lo hacemos inclusivo hasta fin de día local
        h = hasta
        if h.tzinfo is None:
            h = h.replace(tzinfo=LOCAL_TZ)
        if (h.hour, h.minute, h.second, h.microsecond) == (0, 0, 0, 0):
            h = h.replace(hour=23, minute=59, second=59, microsecond=999999)
        filtros.append("s.fecha <= %s")
        params.append(h.astimezone(timezone.utc))

    if usuario_id:
        filtros.append("s.usuario_id = %s")
        params.append(int(usuario_id))

    if categoria_slug:
        filtros.append("""
            EXISTS (
              SELECT 1 FROM categorias c
              WHERE c.id = s.categoria_id AND c.slug = %s
            )
        """)
        params.append(categoria_slug)

    where = "WHERE " + " AND ".join(filtros) if filtros else ""

    # --- Queries ---
    q_totales = f"""
      SELECT
        COUNT(*) AS secuencias,
        COALESCE(SUM(fc.cnt), 0) AS frames
      FROM secuencias s
      LEFT JOIN (
        SELECT secuencia_id, COUNT(*) AS cnt
        FROM frames
        GROUP BY secuencia_id
      ) fc ON fc.secuencia_id = s.id
      {where}
    """

    q_frames_por_secuencia = f"""
      SELECT AVG(fc.cnt)::float AS avg
      FROM (
        SELECT s.id, COUNT(f.*) AS cnt
        FROM secuencias s
        LEFT JOIN frames f ON f.secuencia_id = s.id
        {where}
        GROUP BY s.id
      ) fc
    """

    q_frame_span = f"""
      SELECT AVG(span)::float AS avg
      FROM (
        SELECT s.id, 
               CASE WHEN COUNT(f.*) > 0
                    THEN (MAX(f.num_frame) - MIN(f.num_frame) + 1)
                    ELSE 0 END AS span
        FROM secuencias s
        LEFT JOIN frames f ON f.secuencia_id = s.id
        {where}
        GROUP BY s.id
      ) t
    """

    # Series por día en hora local
    q_seq_por_dia = f"""
      SELECT (s.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Guayaquil')::date AS dia,
             COUNT(*) AS total
      FROM secuencias s
      {where}
      GROUP BY 1
      ORDER BY 1
    """

    q_frames_por_dia = f"""
      SELECT (s.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Guayaquil')::date AS dia,
             COUNT(f.*) AS total
      FROM secuencias s
      LEFT JOIN frames f ON f.secuencia_id = s.id
      {where}
      GROUP BY 1
      ORDER BY 1
    """

    q_categorias = f"""
      SELECT COALESCE(c.slug, 'sin_categoria') AS slug,
             s.subcategoria,
             COUNT(*) AS total
      FROM secuencias s
      LEFT JOIN categorias c ON c.id = s.categoria_id
      {where}
      GROUP BY 1,2
      ORDER BY total DESC, slug ASC
    """

    q_usuarios = f"""
      SELECT COALESCE(s.usuario_id, 0) AS usuario_id, COUNT(*) AS total
      FROM secuencias s
      {where}
      GROUP BY 1
      ORDER BY total DESC
    """

    q_horas = f"""
      SELECT EXTRACT(HOUR FROM (s.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Guayaquil'))::int AS hora_0_23,
             COUNT(*) AS total
      FROM secuencias s
      {where}
      GROUP BY 1
      ORDER BY 1
    """

    try:
        with get_connection() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Totales y promedios
            cur.execute(q_totales, params)
            tot = cur.fetchone() or {"secuencias": 0, "frames": 0}

            cur.execute(q_frames_por_secuencia, params)
            fpsq = cur.fetchone() or {"avg": 0.0}

            cur.execute(q_frame_span, params)
            fspan = cur.fetchone() or {"avg": 0.0}

            # Series / distribuciones
            cur.execute(q_seq_por_dia, params)
            seq_dia = cur.fetchall() or []

            cur.execute(q_frames_por_dia, params)
            fr_dia = cur.fetchall() or []

            cur.execute(q_categorias, params)
            cats = cur.fetchall() or []

            cur.execute(q_usuarios, params)
            users = cur.fetchall() or []

            cur.execute(q_horas, params)
            horas = cur.fetchall() or []

        frames_por_sec = float(fpsq.get("avg") or 0.0)
        frame_span_prom = float(fspan.get("avg") or 0.0)
        dur_est = (frame_span_prom / fps) if fps > 0 else None

        out = {
            "rango": {
                "desde": _iso_utc_z(desde) if desde else None,
                "hasta": _iso_utc_z(hasta) if hasta else None
            },
            "totales": {
                "secuencias": int(tot.get("secuencias", 0)),
                "frames": int(tot.get("frames", 0))
            },
            "promedios": {
                "frames_por_secuencia": frames_por_sec,
                "frame_span": frame_span_prom,
                "duracion_estimada_seg": float(round(dur_est, 3)) if dur_est is not None else None,
                "fps_asumido": fps
            },
            "series": {
                "secuencias_por_dia": [
                    {"dia": str(r["dia"]), "total": int(r["total"])} for r in seq_dia
                ],
                "frames_por_dia": [
                    {"dia": str(r["dia"]), "total": int(r["total"])} for r in fr_dia
                ]
            },
            "categorias": [
                {"slug": r["slug"], "subcategoria": r["subcategoria"], "total": int(r["total"])} for r in cats
            ],
            "usuarios": [
                {"usuario_id": int(r["usuario_id"]), "total": int(r["total"])} for r in users
            ],
            "horas": [
                {"hora_0_23": int(r["hora_0_23"]), "total": int(r["total"])} for r in horas
            ]
        }
        return jsonify({"ok": True, "metrics": out}), 200

    except Exception as e:
        # Devuelve JSON siempre, para que el frontend lo maneje sin romperse
        return jsonify({"ok": False, "error": str(e)}), 500
