import os
from os.path import join, dirname, abspath
from flask import Flask, send_from_directory, redirect, session, url_for
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

# 🌐 CORS: solo acepta desde tu frontend en Firebase
CORS(app,
     supports_credentials=True,
     origins=["https://gestosug2025-peter.web.app"],
     methods=["GET", "POST", "OPTIONS"],
     allow_headers=["Content-Type", "Authorization"])

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
    if archivo.startswith(('css/', 'js/', 'img/')):
        return send_from_directory(FRONTEND_DIR, archivo)
    return send_from_directory(FRONTEND_DIR, 'login.html')



# 🚀 Ejecutar en local
if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=8080)
