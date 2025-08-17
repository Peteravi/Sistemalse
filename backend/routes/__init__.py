from .api import api_bp
from .autenticacion import auth_bp
from .historial import historial_bp  
from .metricas import metricas_bp 

def registrar_rutas(app):
    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(historial_bp, url_prefix="/api")
    app.register_blueprint(metricas_bp, url_prefix="/api")
    app.register_blueprint(auth_bp)
