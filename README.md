# Videoteca para Netlify

Catálogo de videos al inicio, reproductor por video y panel (/admin) para agregar o quitar videos.
Todo lo genera una función de Netlify, sin archivos estáticos. Los videos se guardan en Netlify Blobs, así que no se pierden al volver a desplegar.

## Subir a Netlify
1. Sube esta carpeta a un repositorio de GitHub.
2. En Netlify: Add new site > Import an existing project, elige el repo.
3. Deja vacíos el Build command y el Publish directory se toma de netlify.toml.
4. En Site configuration > Environment variables agrega:
   - `ADMIN_PASSWORD`: contraseña del panel. Obligatoria.
   - `SITE_NAME`: nombre del sitio (opcional).
   - `SESSION_SECRET`: texto largo aleatorio (opcional).
5. Despliega y entra a `tu-sitio.netlify.app/admin` para agregar videos.

## Enlaces compatibles
Mega (enlace de archivo con clave), YouTube, Google Drive (público), Vimeo, Dropbox y enlaces directos .mp4/.webm.
Las carpetas de Mega no se pueden reproducir: usa el enlace de cada archivo.
