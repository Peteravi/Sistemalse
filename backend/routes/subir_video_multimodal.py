from __future__ import annotations
import os, math, json, tempfile
from typing import List, Dict, Optional, Tuple
import numpy as np
import cv2
from flask import Blueprint, request, jsonify, current_app
from werkzeug.utils import secure_filename
from bd.conexion import get_connection

try:
    import mediapipe as mp
    _mp_ok = True
except Exception:
    _mp_ok = False

bp = Blueprint("subir_video_multimodal", __name__)

ALLOWED_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
DEFAULT_TARGET_FPS = 6

def _allowed_file(filename: str) -> bool:
    return os.path.splitext(filename.lower())[1] in ALLOWED_EXTS

# ---------- helpers de normalización ----------
def _to_np(landmarks):
    """Convierte lista de landmarks MediaPipe a np.array (N,3)."""
    return np.array([[p.x, p.y, getattr(p, "z", 0.0)] for p in landmarks], dtype=np.float32)

def _to_dict(arr: np.ndarray) -> List[Dict[str, float]]:
    return [{"x": float(x), "y": float(y), "z": float(z)} for x, y, z in arr]

def _rot2d(theta: float) -> np.ndarray:
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, -s],[s, c]], dtype=np.float32)

def _normalize_pose(arr: np.ndarray) -> np.ndarray:
    """
    Centro: mid-hips (avg de 23 y 24)
    Escala: ancho de hombros (distancia 11-12)
    Rotación: alinear línea de hombros con eje X.
    """
    if arr.shape[0] < 25:  # Pose tiene 33; por si vienen menos
        return arr
    # Centro en cadera media
    mid_hips = (arr[23, :3] + arr[24, :3]) / 2.0
    arr = arr - mid_hips

    # Escala por hombros
    shoulder_vec = arr[12, :3] - arr[11, :3]
    scale = np.linalg.norm(shoulder_vec[:2]) or np.linalg.norm(arr[:, :2])
    if scale > 1e-6:
        arr = arr / scale

    # Rotación 2D (xy)
    ang = math.atan2(shoulder_vec[1], shoulder_vec[0] + 1e-9)
    R = _rot2d(-ang)
    arr[:, :2] = arr[:, :2] @ R.T
    return arr

def _normalize_face(arr: np.ndarray) -> np.ndarray:
    """
    Centro: nariz (0)
    Escala: distancia inter-ocular (33-263)
    Rotación opcional: NO, se deja como está (mejor para detalle fino).
    """
    if arr.shape[0] == 0:
        return arr
    origin = arr[0, :3].copy()
    arr = arr - origin
    # dist inter-ocular (puntos comunes de FaceMesh)
    idx_l, idx_r = 33, 263
    if max(idx_l, idx_r) < arr.shape[0]:
        scale = np.linalg.norm(arr[idx_r, :2] - arr[idx_l, :2])
    else:
        scale = np.linalg.norm(arr[:, :2])
    if scale > 1e-6:
        arr = arr / scale
    return arr

def _normalize_hand(arr: np.ndarray) -> np.ndarray:
    """
    Igual a tu idea: centro en 0 (wrist), escala por norma o palma, rota alineando 0->5 al eje X.
    """
    if arr.shape[0] < 21:
        return arr
    origin = arr[0, :3].copy()
    arr = arr - origin
    ref = arr[9, :3]
    scale = np.linalg.norm(ref) or np.linalg.norm(arr)
    if scale > 1e-6:
        arr = arr / scale
    v = arr[5, :2]
    ang = math.atan2(v[1], v[0] + 1e-9)
    R = _rot2d(-ang)
    arr[:, :2] = arr[:, :2] @ R.T
    return arr

def _insert_secuencia(cur, nombre: str, categoria_slug: Optional[str], subcategoria: Optional[str],
                      usuario_id: Optional[int]) -> int:
    categoria_id = None
    if categoria_slug:
        cur.execute("SELECT id FROM categorias WHERE slug=%s LIMIT 1", (categoria_slug,))
        r = cur.fetchone()
        if r: categoria_id = r[0] if isinstance(r, tuple) else r.get("id")
    cur.execute("""
        INSERT INTO secuencias (nombre, fecha, usuario_id, categoria_id, subcategoria)
        VALUES (COALESCE(%s,''), NOW(), %s, %s, %s)
        RETURNING id
    """, (nombre, usuario_id, categoria_id, subcategoria))
    row = cur.fetchone()
    return row[0] if isinstance(row, tuple) else row.get("id")

def _insert_frame(cur, secuencia_id: int, num_frame: int, payload_json) -> int:
    cur.execute("""
        INSERT INTO frames (secuencia_id, num_frame, landmarks)
        VALUES (%s, %s, %s) RETURNING id
    """, (secuencia_id, num_frame, json.dumps(payload_json, ensure_ascii=False)))
    r = cur.fetchone()
    return r[0] if isinstance(r, tuple) else r.get("id")

@bp.route("/subir_video_multimodal", methods=["POST"])
def subir_video_multimodal():
    """
    Extrae: pose(33), face(468), left_hand(21), right_hand(21) con normalización por modalidad.
    Guarda en frames.landmarks un JSON:
    {
      "pose": [...], "face": [...],
      "left_hand": [...], "right_hand": [...],
      "meta": {"t_s": float, "fps_native": float}
    }
    """
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
    detecciones = {"pose":0, "face":0, "hands":0}
    peek_frame = None

    try:
        with get_connection() as conn, conn.cursor() as cur:
            secuencia_id = _insert_secuencia(cur, titulo, categoria_slug, subcategoria, usuario_id)
            conn.commit()

            cap = cv2.VideoCapture(tmp_path)
            if not cap.isOpened():
                raise RuntimeError("No se pudo abrir el video")
            native_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            frame_interval = max(1, int(round((native_fps / float(target_fps)))))  # muestreo

            mp_holistic = mp.solutions.holistic
            holistic = mp_holistic.Holistic(
                static_image_mode=False,
                model_complexity=1,
                refine_face_landmarks=True,
                enable_segmentation=False,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5
            )

            idx = 0
            num_frame = 0
            ok, frame = cap.read()
            while ok:
                if idx % frame_interval == 0:
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    res = holistic.process(rgb)

                    pose_json = face_json = lhand_json = rhand_json = []
                    any_modality = False

                    # Pose / torso
                    if res.pose_landmarks:
                        arr = _to_np(res.pose_landmarks.landmark)
                        arr = _normalize_pose(arr)
                        pose_json = _to_dict(arr)
                        detecciones["pose"] += 1
                        any_modality = True

                    # Face
                    if res.face_landmarks:
                        arr = _to_np(res.face_landmarks.landmark)
                        arr = _normalize_face(arr)
                        face_json = _to_dict(arr)
                        detecciones["face"] += 1
                        any_modality = True

                    # Left hand
                    if res.left_hand_landmarks:
                        arr = _to_np(res.left_hand_landmarks.landmark)
                        arr = _normalize_hand(arr)
                        lhand_json = _to_dict(arr)
                        any_modality = True

                    # Right hand
                    if res.right_hand_landmarks:
                        arr = _to_np(res.right_hand_landmarks.landmark)
                        arr = _normalize_hand(arr)
                        rhand_json = _to_dict(arr)
                        any_modality = True

                    if any_modality:
                        payload = {
                            "pose": pose_json,
                            "face": face_json,
                            "left_hand": lhand_json,
                            "right_hand": rhand_json,
                            "meta": {"t_s": round(float(idx/(native_fps or 30.0)), 3),
                                     "fps_native": float(native_fps)}
                        }
                        _insert_frame(cur, secuencia_id, num_frame=num_frame, payload_json=payload)
                        frames_guardados += 1

                        # último peek
                        peek_frame = payload

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
            "detecciones": detecciones,
            "duracion_segundos": round(float(duracion), 2),
            "sampled_fps": target_fps,
            "peek_frame": peek_frame or {}
        }), 200

    except Exception as e:
        current_app.logger.exception("Error en /subir_video_multimodal")
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        try:
            if cap is not None: cap.release()
        except Exception: pass
        try:
            if tmp_path and os.path.exists(tmp_path): os.remove(tmp_path)
        except Exception: pass
