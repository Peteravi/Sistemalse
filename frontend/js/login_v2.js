document.getElementById("btnAcceder").addEventListener("click", async () => {
    const usuario = document.getElementById("usuario").value.trim();
    const contrasena = document.getElementById("contrasena").value.trim();
    const errorMsg = document.getElementById("error-msg");

    errorMsg.style.display = "none";

    if (!usuario || !contrasena) {
        errorMsg.textContent = "⚠️ Completa todos los campos.";
        errorMsg.style.display = "block";
        return;
    }

    try {
        const res = await fetch("https://lse-backend-479238723367.us-central1.run.app/login", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usuario, contrasena })
        });

        const data = await res.json();

        if (res.ok && data.ok) {
            window.location.replace("https://gestosug2025-peter.web.app/sistema_v2.html");
        } else {
            throw new Error(data.message || "Credenciales inválidas");
        }

    } catch (error) {
        errorMsg.textContent = "❌ Error al iniciar sesión.";
        errorMsg.style.display = "block";
    }
});

function togglePassword() {
    const input = document.getElementById("contrasena");
    const icono = document.getElementById("icono-ojo");

    if (input.type === "password") {
        input.type = "text";
        icono.classList.remove("bi-eye");
        icono.classList.add("bi-eye-slash");
    } else {
        input.type = "password";
        icono.classList.remove("bi-eye-slash");
        icono.classList.add("bi-eye");
    }
}