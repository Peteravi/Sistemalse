# routes/secuencias.py
from flask import Blueprint, jsonify
from bd.conexion import get_connection

secuencias_bp = Blueprint('secuencias_bp', __name__)

@secuencias_bp.route('/api/secuencias')
def obtener_historial():
    conn = get_connection()
    cur = conn.cursor()  # funciona con cursor normal o DictCursor
    cur.execute("SELECT id, nombre, fecha FROM secuencias ORDER BY id DESC LIMIT 30")
    resultados = cur.fetchall()
    conn.close()

    items = []
    for row in resultados:
        if isinstance(row, (list, tuple)):
            _id, _nom, _fec = row
        else:
            _id  = row.get("id")
            _nom = row.get("nombre")
            _fec = row.get("fecha")
        items.append({
            "id": _id,
            "nombre": _nom,
            "fecha": _fec.isoformat() if hasattr(_fec, "isoformat") else (str(_fec) if _fec else None)
        })
    return jsonify(items)
