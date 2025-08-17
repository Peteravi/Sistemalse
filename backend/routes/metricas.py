# backend/routes/metricas.py
from flask import Blueprint, request, jsonify
from bd.conexion import get_connection
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

metricas_bp = Blueprint("metricas_bp", __name__)

LOCAL_TZ = ZoneInfo("America/Guayaquil")

def _parse_date_or_none(s: str | None):
    if not s:
        return None
    try:
        # acepta YYYY-MM-DD o ISO
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        try:
            return datetime.strptime(s, "%Y-%m-%d")
        except Exception:
            return None

def _iso_utc_z(dt):
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

@metricas_bp.route("/metrics/overview", methods=["GET"])
def overview():
    """
    GET /api/metrics/overview?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&fps=30&usuario_id=&categoria_slug=
    Devuelve:
    {
      rango: {desde, hasta},
      totales: {secuencias, frames},
      promedios: {frames_por_secuencia, frame_span, duracion_estimada_seg},
      series: {secuencias_por_dia: [{dia, total}], frames_por_dia: [...]},
      categorias: [{slug, subcategoria, total}],
      usuarios: [{usuario_id, total}],
      horas: [{hora_0_23, total}]
    }
    """
    desde = _parse_date_or_none(request.args.get("desde"))
    hasta = _parse_date_or_none(request.args.get("hasta"))
    fps = float(request.args.get("fps", 30))
    usuario_id = request.args.get("usuario_id")
    categoria_slug = (request.args.get("categoria_slug") or "").strip().lower()

    filtros = []
    params = []

    # secuencias.fecha está en UTC; convertimos a local para agrupar
    if desde:
        filtros.append("s.fecha >= %s")
        params.append(desde.astimezone(timezone.utc))
    if hasta:
        # hacerlo inclusivo si es solo fecha
        h = hasta
        if h.tzinfo is None:
            h = h.replace(tzinfo=LOCAL_TZ)
        if h.hour == 0 and h.minute == 0 and h.second == 0 and h.microsecond == 0:
            # fin del día local -> pasa a UTC
            h = (h.replace(hour=23, minute=59, second=59, microsecond=999999)).astimezone(timezone.utc)
        else:
            h = h.astimezone(timezone.utc)
        filtros.append("s.fecha <= %s")
        params.append(h)

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
      SELECT AVG(fc.cnt)::float
      FROM (
        SELECT s.id, COUNT(f.*) AS cnt
        FROM secuencias s
        LEFT JOIN frames f ON f.secuencia_id = s.id
        {where}
        GROUP BY s.id
      ) fc
    """

    q_frame_span = f"""
      SELECT AVG(span)::float
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

    # Series por día (en hora local)
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

    # Distribución por categoría/subcategoría
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

    # Distribución por usuario
    q_usuarios = f"""
      SELECT COALESCE(s.usuario_id, 0) AS usuario_id, COUNT(*) AS total
      FROM secuencias s
      {where}
      GROUP BY 1
      ORDER BY total DESC
    """

    # Actividad por hora local
    q_horas = f"""
      SELECT EXTRACT(HOUR FROM (s.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Guayaquil'))::int AS hora_0_23,
             COUNT(*) AS total
      FROM secuencias s
      {where}
      GROUP BY 1
      ORDER BY 1
    """

    try:
        with get_connection() as conn, conn.cursor() as cur:
            cur.execute(q_totales, params); tot = cur.fetchone() or {}
            cur.execute(q_frames_por_secuencia, params); fpsq = cur.fetchone()
            cur.execute(q_frame_span, params); fspan = cur.fetchone()

            cur.execute(q_seq_por_dia, params); seq_dia = cur.fetchall()
            cur.execute(q_frames_por_dia, params); fr_dia = cur.fetchall()

            cur.execute(q_categorias, params); cats = cur.fetchall()
            cur.execute(q_usuarios, params); users = cur.fetchall()
            cur.execute(q_horas, params); horas = cur.fetchall()

        frames_por_sec = (fpsq["avg"] if isinstance(fpsq, dict) else fpsq[0]) if fpsq else 0.0
        frame_span_prom = (fspan["avg"] if isinstance(fspan, dict) else fspan[0]) if fspan else 0.0
        dur_est = (frame_span_prom / fps) if fps > 0 else None

        out = {
            "rango": {"desde": _iso_utc_z(desde) if desde else None,
                      "hasta": _iso_utc_z(hasta) if hasta else None},
            "totales": {"secuencias": int(tot.get("secuencias", 0)),
                        "frames": int(tot.get("frames", 0))},
            "promedios": {
                "frames_por_secuencia": float(frames_por_sec or 0),
                "frame_span": float(frame_span_prom or 0),
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
        return jsonify({"ok": True, "metrics": out})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
