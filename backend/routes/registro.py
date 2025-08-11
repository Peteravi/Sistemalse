from bd.conexion import get_connection
import json
import traceback
from psycopg2.extras import DictCursor

def crear_secuencia(nombre, usuario_id):
    try:
        conn = get_connection()
        if conn is None:
            print("❌ Error: conexión no establecida en crear_secuencia")
            return None
        cursor = conn.cursor(cursor_factory=DictCursor)
        print(f"➕ Insertando nueva secuencia con nombre: '{nombre}'")

        cursor.execute(
            "INSERT INTO secuencias (nombre, usuario_id) VALUES (%s, %s) RETURNING id",
            (nombre, usuario_id)
        )
        row = cursor.fetchone()

        if row is None:
            print("⚠️ No se devolvió ningún ID tras el INSERT.")
            conn.rollback()
            conn.close()
            return None

        # ✅ Acceso correcto usando DictCursor
        secuencia_id = row["id"]
        conn.commit()
        print(f"✅ Secuencia creada con ID: {secuencia_id}")
        conn.close()
        return secuencia_id

    except Exception as e:
        print("❌ Excepción en crear_secuencia:")
        traceback.print_exc()
        return None


def insertar_frame(secuencia_id, num_frame, landmarks):
    try:
        conn = get_connection()
        if conn is None:
            print("❌ Error: conexión no establecida en insertar_frame")
            return

        cursor = conn.cursor()
        print(f"💾 Insertando frame #{num_frame} en secuencia ID {secuencia_id}")
        cursor.execute(
            "INSERT INTO frames (secuencia_id, num_frame, landmarks) VALUES (%s, %s, %s)",
            (secuencia_id, num_frame, json.dumps(landmarks))
        )
        conn.commit()
        print("✅ Frame insertado correctamente")
        conn.close()

    except Exception as e:
        print("❌ Excepción en insertar_frame:")
        traceback.print_exc()
