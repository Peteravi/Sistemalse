document.addEventListener("DOMContentLoaded", () => {
    const usuario = document.getElementById("usuario");
    const contrasena = document.getElementById("contrasena");
    const btnAcceder = document.getElementById("btnAcceder");
    const errorBox = document.getElementById("error-box");
    const toggleSpan = document.getElementById("togglePassword");
    const toggleIcon = document.getElementById("icono-ojo");
    const anio = document.getElementById("anio");
    if (anio) anio.textContent = new Date().getFullYear();

    const showError = (msg) => {
        if (!errorBox) return;
        errorBox.innerHTML = `<span class="error-text">${msg}</span>`;
    };
    const clearError = () => (errorBox.innerHTML = "");

    // --- Mostrar/Ocultar contraseña ---
    function togglePassword() {
        if (!contrasena || !toggleIcon || !toggleSpan) return;
        const hidden = contrasena.type === "password";
        contrasena.type = hidden ? "text" : "password";
        toggleIcon.classList.toggle("bi-eye", !hidden);
        toggleIcon.classList.toggle("bi-eye-slash", hidden);
        toggleSpan.title = hidden ? "Ocultar contraseña" : "Mostrar contraseña";
        toggleSpan.setAttribute("aria-pressed", String(hidden));
    }

    // Accesibilidad del “botón” del ojo
    if (toggleSpan) {
        toggleSpan.setAttribute("role", "button");
        toggleSpan.setAttribute("tabindex", "0");
        toggleSpan.setAttribute("aria-label", "Mostrar u ocultar contraseña");
        toggleSpan.setAttribute("aria-pressed", "false");
        toggleSpan.addEventListener("click", togglePassword);
        toggleSpan.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                togglePassword();
            }
        });
    }

    // Enter para enviar
    [usuario, contrasena].forEach((el) =>
        el?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") btnAcceder?.click();
        })
    );

    // --- Login ---
    btnAcceder?.addEventListener("click", async () => {
        clearError();
        const u = usuario?.value.trim();
        const p = contrasena?.value.trim();

        if (!u || !p) {
            showError("⚠️ Completa todos los campos.");
            return;
        }

        const originalHTML = btnAcceder.innerHTML;
        btnAcceder.disabled = true;
        btnAcceder.innerHTML = `
      <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
      Accediendo...
    `;

        try {
            const res = await fetch("https://lse-backend-479238723367.us-central1.run.app/login", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ usuario: u, contrasena: p })
            });

            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) {
                window.location.replace("https://gestosug2025-peter.web.app/sistema_v2.html");
            } else {
                showError(data.message || "Credenciales inválidas.");
            }
        } catch (e) {
            showError("❌ Error al iniciar sesión.");
        } finally {
            btnAcceder.disabled = false;
            btnAcceder.innerHTML = originalHTML;
        }
    });
});
