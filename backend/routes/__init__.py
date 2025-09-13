from .api import api_bp
from .autenticacion import auth_bp
from .historial import historial_bp  
from .metricas import metricas_bp 
from .subir_video import bp as subir_video_bp 
from flask import Flask
from .subir_video_multimodal import bp as subir_video_multimodal
def registrar_rutas(app):
    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(historial_bp, url_prefix="/api")
    app.register_blueprint(metricas_bp, url_prefix="/api")
    app.register_blueprint(subir_video_bp, url_prefix="/api") 
    app.register_blueprint(subir_video_multimodal, url_prefix="/api")
    app.register_blueprint(auth_bp)
