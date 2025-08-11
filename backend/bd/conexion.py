import psycopg2
from psycopg2.extras import RealDictCursor

def get_connection():
    try:
        conn = psycopg2.connect(
            host="34.71.11.43",  
            port=5432,
            database="sistemagestiondegestosbd",
            user="lse",  
            password="@Lsegestor2025",
            cursor_factory=RealDictCursor
        )
        print("✅ Conexión a PostgreSQL en Cloud SQL establecida correctamente.")
        return conn
    except Exception as e:
        import traceback
        print("❌ Error al conectar con PostgreSQL en Cloud SQL:", e)
        traceback.print_exc()
        return None
