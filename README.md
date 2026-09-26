# Transmisión X

Plataforma full-stack de videos cortos, pensada para móvil.

## Incluye

- Feed vertical tipo Shorts.
- Registro e inicio de sesión con contraseñas hasheadas con bcrypt.
- Sesiones mediante cookie HttpOnly y JWT.
- Base de datos SQLite para usuarios, videos, likes, comentarios y seguidores.
- Subida de videos desde el móvil.
- Reproducción automática al entrar en pantalla.
- Contador de reproducciones.
- Likes y comentarios.
- Perfiles y seguir/dejar de seguir.
- Diseño responsive con identidad Transmisión X.

## Ejecutar localmente

Requiere Node.js 20+.

```bash
npm install
cp .env.example .env
npm start
```

Luego abre `http://localhost:3000`.

### Producción

Configura una variable `JWT_SECRET` larga y aleatoria y `NODE_ENV=production`. Para una plataforma grande conviene sustituir SQLite/almacenamiento local por PostgreSQL y almacenamiento de objetos + CDN, y añadir transcodificación de video, moderación, límites de subida y copias de seguridad.

## Estructura

- `server.js`: API, autenticación, base de datos y subida.
- `public/index.html`: aplicación móvil.
- `data/`: base SQLite creada automáticamente.
- `uploads/`: videos subidos.

## Nota

La aplicación no promete resultados ni servicios fuera de lo que implemente el servidor. Los videos y cuentas son responsabilidad del administrador de la instancia.
