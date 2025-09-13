# routes/subir_video.py
# -*- coding: utf-8 -*-
"""
Sube un video, extrae landmarks de mano con MediaPipe y los guarda en PostgreSQL.

- Crea UNA sola secuencia en `secuencias`
- Inserta N frames en `frames` con (secuencia_id, num_frame, landmarks JSONB)
- Opcionalmente etiqueta categoría/subcategoría/usuario

Requisitos:
    pip install opencv-python mediapipe numpy
"""
from __future__ import annotations
import os
import math
import time
import tempfile
from typing import List, Dict, Optional, Tuple

import numpy as np
import cv2

from flask import Blueprint, request, jsonify, current_app
from werkzeug.utils import secure_filename

from bd.conexion import get_connection

try:
    import mediapipe as mp
    _mp_ok = True
except Exception as _e:
    _mp_ok = False

bp = Blueprint("subir_video", __name__)

# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────
ALLOWED_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
DEFAULT_TARGET_FPS = 6  # muestreo para no saturar la BD

def _allowed_file(filename: str) -> bool:
    _, ext = os.path.splitext(filename.lower())
    return ext in ALLOWED_EXTS

# ──────────────────────────────────────────────────────────────────────────────
# Normalización simple de landmarks
# ──────────────────────────────────────────────────────────────────────────────
def _normalize_landmarks(pts: List[Dict[str, float]]) -> List[Dict[str, float]]:
    """
    1) Centra en la muñeca (landmark 0)
    2) Escala por distancia palma (0->9 aprox) o norma L2 global
    3) Rotación a eje base (0->5) para orientar la mano
    """
    if not pts or len(pts) < 21:
        return pts

    arr = np.array([[p["x"], p["y"], p["z"]] for p in pts], dtype=np.float32)

    # 1) centrar en la muñeca (0)
    origin = arr[0].copy()
    arr -= origin

    # 2) escala
    ref = arr[9] if len(arr) > 9 else None
    scale = np.linalg.norm(ref) if ref is not None else np.linalg.norm(arr)
    if scale > 1e-6:
        arr /= scale

    # 3) rotación: alinear vector (0->5) con eje X
    if len(arr) > 5:
        v = arr[5]  # índice base
        vx, vy = v[0], v[1]
        ang = math.atan2(vy, vx)
        cos_a, sin_a = math.cos(-ang), math.sin(-ang)
        rot2d = np.array([[cos_a, -sin_a],
                          [sin_a,  cos_a]], dtype=np.float32)
        arr[:, :2] = arr[:, :2] @ rot2d.T

    # devolver como dicts
    out = [{"x": float(x), "y": float(y), "z": float(z)} for x, y, z in arr]
    return out

# ──────────────────────────────────────────────────────────────────────────────
# DB helpers
# ──────────────────────────────────────────────────────────────────────────────
def _insert_secuencia(cur, nombre: str, categoria_slug: Optional[str], subcategoria: Optional[str],
                      usuario_id: Optional[int]) -> int:
    # Resuelve categoria_id desde slug (si existe)
    categoria_id = None
    if categoria_slug:
        try:
            cur.execute("SELECT id FROM categorias WHERE slug=%s LIMIT 1", (categoria_slug,))
            r = cur.fetchone()
            if r:
                categoria_id = r[0] if isinstance(r, tuple) else r.get("id")
        except Exception:
            categoria_id = None

    cur.execute("""
        INSERT INTO secuencias (nombre, fecha, usuario_id, categoria_id, subcategoria)
        VALUES (COALESCE(%s,''), NOW(), %s, %s, %s)
        RETURNING id
    """, (nombre, usuario_id, categoria_id, subcategoria))
    row = cur.fetchone()
    return row[0] if isinstance(row, tuple) else row.get("id")

def _insert_frame(cur, secuencia_id: int, num_frame: int, landmarks_json) -> int:
    import json
    cur.execute("""
        INSERT INTO frames (secuencia_id, num_frame, landmarks)
        VALUES (%s, %s, %s) RETURNING id
    """, (secuencia_id, num_frame, json.dumps(landmarks_json, ensure_ascii=False)))
    r = cur.fetchone()
    return r[0] if isinstance(r, tuple) else r.get("id")

# ──────────────────────────────────────────────────────────────────────────────
# Ruta principal
# ──────────────────────────────────────────────────────────────────────────────
@bp.route("/subir_video", methods=["POST"])
def subir_video():
    if not _mp_ok:
        return jsonify({"ok": False, "error": "MediaPipe no está instalado"}), 500
    if "video" not in request.files:
        return jsonify({"ok": False, "error": "Falta 'video' en el form-data"}), 400

    file = request.files["video"]
    if not file or not file.filename:
        return jsonify({"ok": False, "error": "Archivo vacío"}), 400

    filename = secure_filename(file.filename)
    if not _allowed_file(filename):
        return jsonify({"ok": False, "error": f"Extensión no permitida: {filename}"}), 400

    titulo = (request.form.get("titulo") or "").strip() or os.path.splitext(filename)[0]
    categoria_slug = (request.form.get("categoria_slug") or "").strip().lower() or None
    subcategoria   = (request.form.get("subcategoria") or "").strip() or None
    try:
        usuario_id = int(request.form.get("usuario_id", "").strip() or 0) or None
    except Exception:
        usuario_id = None
    try:
        target_fps = int(request.form.get("target_fps", "").strip() or 0) or DEFAULT_TARGET_FPS
        target_fps = max(1, min(15, target_fps))
    except Exception:
        target_fps = DEFAULT_TARGET_FPS

    with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(filename)[1]) as tmp:
        file.save(tmp.name)
        tmp_path = tmp.name

    cap = None
    frames_guardados = 0
    manos_detectadas = 0
    peek_frame = None

    try:
        with get_connection() as conn, conn.cursor() as cur:
            # 1) crea secuencia
            secuencia_id = _insert_secuencia(cur, titulo, categoria_slug, subcategoria, usuario_id)
            conn.commit()

            # 2) abre video y configura muestreo
            cap = cv2.VideoCapture(tmp_path)
            if not cap.isOpened():
                raise RuntimeError("No se pudo abrir el video")
            native_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            frame_interval = max(1, int(round((native_fps / float(target_fps)))))

            # 3) MediaPipe
            mp_hands = mp.solutions.hands
            hands = mp_hands.Hands(
                static_image_mode=False,
                max_num_hands=1,
                model_complexity=1,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )

            idx = 0
            num_frame = 0
            ok, frame = cap.read()
            while ok:
                if idx % frame_interval == 0:
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    res = hands.process(rgb)
                    if res.multi_hand_landmarks:
                        lm = res.multi_hand_landmarks[0]
                        pts = [{"x": float(p.x), "y": float(p.y), "z": float(p.z)} for p in lm.landmark]
                        pts_norm = _normalize_landmarks(pts)

                        _insert_frame(cur, secuencia_id, num_frame=num_frame, landmarks_json=pts_norm)
                        frames_guardados += 1
                        manos_detectadas += 1

                        # guarda el último “peek”
                        peek_frame = {
                            "t_s": round(float(idx / (native_fps or 30.0)), 3),
                            "mano": (res.multi_handedness[0].classification[0].label
                                     if getattr(res, "multi_handedness", None) else "unknown"),
                            "idx_frame": num_frame,
                            "landmarks": pts_norm
                        }
                idx += 1
                num_frame += 1
                ok, frame = cap.read()

            conn.commit()

        try:
            duracion = cap.get(cv2.CAP_PROP_FRAME_COUNT) / (native_fps or 30.0)
        except Exception:
            duracion = 0.0

        return jsonify({
            "ok": True,
            "secuencia_id": secuencia_id,
            "titulo": titulo,
            "categoria_slug": categoria_slug,
            "subcategoria": subcategoria,
            "frames_guardados": frames_guardados,
            "manos_detectadas": manos_detectadas,
            "duracion_segundos": round(float(duracion), 2),
            "sampled_fps": target_fps,
            "peek_frame": peek_frame or {}
        }), 200

    except Exception as e:
        current_app.logger.exception("Error en /subir_video")
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        try:
            if cap is not None: cap.release()
        except Exception: pass
        try:
            if tmp_path and os.path.exists(tmp_path): os.remove(tmp_path)
        except Exception: pass

# ──────────────────────────────────────────────────────────────────────────────

@bp.route("/secuencias/<int:secuencia_id>/peek", methods=["GET"])
def peek_secuencia(secuencia_id: int):
    try:
        with get_connection() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT num_frame, landmarks
                FROM frames
                WHERE secuencia_id=%s
                ORDER BY num_frame DESC
                LIMIT 1
            """, (secuencia_id,))
            r = cur.fetchone()
            if not r:
                return jsonify({"ok": True, "peek_frame": {}}), 200
            num_frame, landmarks = r[0], r[1]
            return jsonify({"ok": True, "peek_frame": {
                "idx_frame": num_frame,
                "landmarks": landmarks
            }}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/secuencias/<int:secuencia_id>/frames", methods=["GET"])
def frames_secuencia(secuencia_id: int):
    """Devuelve hasta 'limit' frames (por defecto 50) para mostrar en el panel JSON."""
    try:
        limit = int(request.args.get("limit", 50))
        limit = max(1, min(500, limit))
        with get_connection() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT num_frame, landmarks
                FROM frames
                WHERE secuencia_id=%s
                ORDER BY num_frame ASC
                LIMIT %s
            """, (secuencia_id, limit))
            rows = cur.fetchall() or []
            data = [{"idx_frame": r[0], "landmarks": r[1]} for r in rows]
            return jsonify({"ok": True, "count": len(data), "items": data}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
