import os
from os.path import join, dirname, abspath

from flask import Flask, send_from_directory, redirect, session, url_for, request
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

# ──────────────────────────────────────────────────────────────────────────────
# 🔧 Carga de .env (en local) y detección de ambiente
# ──────────────────────────────────────────────────────────────────────────────
try:
    from dotenv import load_dotenv
    _HERE = dirname(abspath(__file__))
    load_dotenv(join(_HERE, ".env"))
    load_dotenv(join(_HERE, "..", ".env"))
except Exception:
    pass

ENV = (os.environ.get("FLASK_ENV") or "production").lower()
IS_PROD = ENV == "production"

# ──────────────────────────────────────────────────────────────────────────────
# 📁 Rutas base
# ──────────────────────────────────────────────────────────────────────────────
BASE_DIR = dirname(abspath(__file__))
FRONTEND_DIR = join(BASE_DIR, '..', 'frontend')

# ──────────────────────────────────────────────────────────────────────────────
# ⚙️ Inicializar Flask App
# ──────────────────────────────────────────────────────────────────────────────
app = Flask(
    __name__,
    static_folder=FRONTEND_DIR,   # sirve /frontend como estático
    static_url_path=''            # raíz
)

# 🔐 Clave de sesión
app.secret_key = os.environ.get('SECRET_KEY', 'captura-lse-ug')

# 🍪 Cookies de sesión (seguras en prod, compatibilidad en local)
app.config.update(
    SESSION_COOKIE_SAMESITE="None" if IS_PROD else "Lax",
    SESSION_COOKIE_SECURE=IS_PROD
)

# ✅ Cloud Run / proxies: respeta X-Forwarded-* (protocolo/host/ip)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# ──────────────────────────────────────────────────────────────────────────────
# 🌐 CORS
# ──────────────────────────────────────────────────────────────────────────────
def _get_allowed_origins():
    raw = os.environ.get("FRONTEND_ORIGINS") or os.environ.get("FRONTEND_ORIGIN", "")
    defaults = [
        # Local (Flask como API y/o frontend)
        "http://127.0.0.1:8080",
        "http://localhost:8080",
        "http://127.0.0.1:5000",
        "http://localhost:5000",
        # Live Server / Vite / etc.
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://localhost:5173",
        # Producción (ajusta/añade los tuyos)
        "https://gestosug2025-peter.web.app",
        "https://gestosug2025-peter.firebaseapp.com",
        # Si usas Cloud Run con dominio propio, puedes añadirlo aquí:
        # "https://lse-backend-XXXXXXXX-uc.a.run.app",
    ]
    extra = [o.strip() for o in raw.split(",") if o.strip()]
    seen, result = set(), []
    for o in (extra + defaults):
        if o not in seen:
            seen.add(o)
            result.append(o)
    return result

ALLOWED_ORIGINS = _get_allowed_origins()

CORS(
    app,
    resources={r"/*": {"origins": ALLOWED_ORIGINS}},
    supports_credentials=True,
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With"],
    expose_headers=["Content-Type", "Authorization"],
    max_age=86400
)

# Añade headers CORS a *todas* las respuestas (incluye redirects/errores)
@app.after_request
def add_cors_headers(resp):
    origin = request.headers.get("Origin")
    if origin and origin in ALLOWED_ORIGINS:
        resp.headers.setdefault("Access-Control-Allow-Origin", origin)
        resp.headers.setdefault("Vary", "Origin")
        resp.headers.setdefault("Access-Control-Allow-Credentials", "true")
        resp.headers.setdefault("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        resp.headers.setdefault("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
    return resp

# Preflight genérico (si algún blueprint no define OPTIONS)
@app.route("/<path:anypath>", methods=["OPTIONS"])
def cors_preflight(anypath):
    return ("", 204)

# ──────────────────────────────────────────────────────────────────────────────
# 🔁 Registrar rutas de todos los blueprints
# ──────────────────────────────────────────────────────────────────────────────
from routes import registrar_rutas
registrar_rutas(app)

# ──────────────────────────────────────────────────────────────────────────────
# 🌐 Rutas de vistas estáticas (login / sistema)
# ──────────────────────────────────────────────────────────────────────────────
@app.route('/')
def login_view():
    return send_from_directory(FRONTEND_DIR, 'login.html')

@app.route('/sistema_v2.html')
def sistema_view():
    if 'usuario' not in session:
        return redirect(url_for('login_view'))
    return send_from_directory(FRONTEND_DIR, 'sistema_v2.html')

# Servir recursos estáticos del frontend
@app.route('/<path:archivo>')
def servir_archivos(archivo):
    if archivo.startswith(('css/', 'js/', 'img/', 'assets/', 'favicon')):
        return send_from_directory(FRONTEND_DIR, archivo)
    # Fallback a login
    return send_from_directory(FRONTEND_DIR, 'login.html')

# ──────────────────────────────────────────────────────────────────────────────
# 🩺 Healthcheck (útil para Cloud Run)
# ──────────────────────────────────────────────────────────────────────────────
@app.route('/health', methods=['GET'])
def health():
    return {"ok": True}, 200

# ──────────────────────────────────────────────────────────────────────────────
# 🚀 Ejecutar
# ──────────────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    default_port = 5000
    port = int(os.environ.get("PORT", default_port))
    print(f"ENV={ENV}  |  IS_PROD={IS_PROD}")
    print("CORS ALLOWED_ORIGINS:", ALLOWED_ORIGINS)
    app.run(debug=not IS_PROD, host='127.0.0.1', port=port)
