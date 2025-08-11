from flask import Blueprint, request, jsonify, session

auth_bp = Blueprint('auth_bp', __name__)

# 👉 Login: permite POST desde el frontend
@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.get_json() if request.is_json else request.form
    usuario = data.get('usuario', '').strip()
    contrasena = data.get('contrasena', '').strip()

    if not usuario or not contrasena:
        return jsonify({'ok': False, 'message': 'Faltan datos'}), 400

    if usuario == 'admin' and contrasena == 'administracionug2025':
        session['usuario'] = usuario
        return jsonify({'ok': True}), 200

    return jsonify({'ok': False, 'message': 'Credenciales incorrectas'}), 401

# 👉 CORS preflight: evita 401 en navegador (OPTIONS request)
@auth_bp.route('/login', methods=['OPTIONS'])
def login_preflight():
    return '', 204

# 👉 Verifica si hay sesión activa
@auth_bp.route('/verificar_sesion', methods=['GET'])
def verificar_sesion():
    if session.get('usuario'):
        return jsonify({'ok': True, 'usuario': session['usuario']}), 200
    return jsonify({'ok': False, 'message': 'Sin sesión'}), 401

# 👉 Cierra sesión
@auth_bp.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'ok': True}), 200
