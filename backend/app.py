import os
from os.path import join, dirname, abspath

from flask import Flask, send_from_directory, redirect, session, url_for, request
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

# 📁 Rutas base
BASE_DIR = dirname(abspath(__file__))
FRONTEND_DIR = join(BASE_DIR, '..', 'frontend')

# ⚙️ Inicializar Flask App
app = Flask(
    __name__,
    static_folder=FRONTEND_DIR,
    static_url_path=''
)

# 🔐 Clave de sesión
app.secret_key = os.environ.get('SECRET_KEY', 'captura-lse-ug')

# 🔒 Cookies seguras para cross-origin entre Cloud Run <-> Firebase
app.config.update(
    SESSION_COOKIE_SAMESITE="None",
    SESSION_COOKIE_SECURE=True
)

# ✅ Middleware para Cloud Run (HTTPS detrás de proxy)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

# 🌐 Orígenes permitidos 
def _get_allowed_origins():
    raw = os.environ.get("FRONTEND_ORIGINS") or os.environ.get("FRONTEND_ORIGIN", "")
    defaults = [
        "https://gestosug2025-peter.web.app", 
        "http://localhost:5173",
        "http://localhost:8080",
        "http://127.0.0.1:5500",
        "http://localhost:5500",
    ]
    if raw.strip():
        return [o.strip() for o in raw.split(",") if o.strip()]
    return defaults

ALLOWED_ORIGINS = _get_allowed_origins()

# 🌐 CORS
CORS(
    app,
    resources={
        r"/api/*":           {"origins": ALLOWED_ORIGINS},
        r"/login":           {"origins": ALLOWED_ORIGINS},
        r"/logout":          {"origins": ALLOWED_ORIGINS},
        r"/session":         {"origins": ALLOWED_ORIGINS},
        r"/":                {"origins": ALLOWED_ORIGINS},
        r"/sistema_v2.html": {"origins": ALLOWED_ORIGINS},
    },
    supports_credentials=True,
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With"],
    expose_headers=["Content-Type", "Authorization"],
    max_age=86400
)

# 🧷 Faja y tirantes: añade headers CORS a cualquier respuesta (incluye redirects/errores)
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

# 📨 Preflight genérico para cualquier ruta (por si algún blueprint no lo maneja)
@app.route("/<path:anypath>", methods=["OPTIONS"])
def cors_preflight(anypath):
    return ("", 204)

# 🔁 Registrar rutas de todos los blueprints y funciones
from routes import registrar_rutas
registrar_rutas(app)

# 🌐 Ruta principal del login
@app.route('/')
def login_view():
    return send_from_directory(FRONTEND_DIR, 'login.html')

# 🏠 Ruta protegida del sistema
@app.route('/sistema_v2.html')
def sistema_view():
    if 'usuario' not in session:
        return redirect(url_for('login_view'))
    return send_from_directory(FRONTEND_DIR, 'sistema_v2.html')

# 📂 Rutas estáticas
@app.route('/<path:archivo>')
def servir_archivos(archivo):
    if archivo.startswith(('css/', 'js/', 'img/', 'assets/', 'favicon')):
        return send_from_directory(FRONTEND_DIR, archivo)
    return send_from_directory(FRONTEND_DIR, 'login.html')

# 🚀 Ejecutar en local
if __name__ == '__main__':
    print("CORS ALLOWED_ORIGINS:", ALLOWED_ORIGINS)
    app.run(debug=True, host='0.0.0.0', port=8080)
