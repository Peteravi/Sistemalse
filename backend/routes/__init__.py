from .api import api_bp
from .secuencias import secuencias_bp
from .autenticacion import auth_bp

def registrar_rutas(app):
    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(secuencias_bp)
    app.register_blueprint(auth_bp)
