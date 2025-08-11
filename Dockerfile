FROM python:3.10-bullseye

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsm6 \
    libxext6 \
    libglib2.0-0 \
    libgl1-mesa-glx \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar TODO el proyecto (backend, frontend, requirements)
COPY . /app

# Instalar dependencias
RUN pip install --upgrade pip
RUN pip install -r requirements.txt

# Puerto usado por Cloud Run
EXPOSE 8080

# Ejecutar backend desde la carpeta backend/
CMD ["gunicorn", "--chdir", "backend", "-b", "0.0.0.0:8080", "app:app"]
