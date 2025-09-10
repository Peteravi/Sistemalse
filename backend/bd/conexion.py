# backend/bd/conexion.py
import os
from urllib.parse import urlparse, unquote
import psycopg2
from psycopg2.extras import RealDictCursor

# Opcional: cargar .env en local
try:
    from dotenv import load_dotenv
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    load_dotenv(os.path.join(BASE_DIR, ".env"))  # backend/.env
except Exception:
    pass

def _connect_from_url(database_url: str):
    """
    Soporta DATABASE_URL estilo:
    postgresql://user:pass@host:5432/dbname
    """
    parsed = urlparse(database_url)
    username = unquote(parsed.username or "")
    password = unquote(parsed.password or "")
    database = parsed.path.lstrip("/")
    host = parsed.hostname or "localhost"
    port = parsed.port or 5432

    return psycopg2.connect(
        host=host,
        port=port,
        database=database,
        user=username,
        password=password,
        cursor_factory=RealDictCursor,
    )

def _connect_from_parts():
    """
    Alternativa por variables sueltas:
    DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
    """
    host = os.environ.get("DB_HOST", "localhost")
    port = int(os.environ.get("DB_PORT", "5432"))
    name = os.environ.get("DB_NAME", "lse_db")
    user = os.environ.get("DB_USER", "postgres")
    pwd  = os.environ.get("DB_PASSWORD", "postgres")

    return psycopg2.connect(
        host=host,
        port=port,
        database=name,
        user=user,
        password=pwd,
        cursor_factory=RealDictCursor,
    )

def get_connection():
    """
    Prioridad:
    1) DATABASE_URL (recomendado)
    2) Variables sueltas (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)
    """
    database_url = os.environ.get("DATABASE_URL")
    try:
        if database_url:
            conn = _connect_from_url(database_url)
            print(f"✅ Conexión OK (DATABASE_URL -> {database_url.split('@')[-1]})")
            return conn
        else:
            conn = _connect_from_parts()
            print("✅ Conexión OK (variables sueltas)")
            return conn
    except Exception as e:
        print("❌ Error al conectar a PostgreSQL:", e)
        raise
