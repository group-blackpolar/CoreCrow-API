# CoreCrow API — Documentación

API de Black Polar, sirviendo en producción en `api.blackpolar.org`.
OpenSource Baseline por Group Black Polar
---

## 1. Overview de arquitectura

| Componente | Detalle |
|---|---|
| Framework HTTP | Fastify 5 |
| ORM | Prisma 6 (`@prisma/client`) |
| Auth de usuarios finales | Better Auth (email/password + Google OAuth) |
| Auth de administradores | Sistema propio vía `adminUniqueId` (no pasa por Better Auth) |
| Base de datos | PostgreSQL 16 (contenedor `corecrow-db`) |
| Cache / sesiones | Redis 7 (contenedor `corecrow-redis`), usado como `secondaryStorage` de Better Auth |
| Runtime en VPS | Docker Compose, contenedor `corecrow-api`, puerto interno `4000` |
| Proxy público | Nginx en el host → `proxy_pass` a `127.0.0.1:4000` |
| Deploy | GitHub Actions (`appleboy/ssh-action`) → SSH al VPS → `docker compose build/up` |
| Directorio | `/var/www/corecrow-api` |

---

## 2. Lanzamiento en máquina local

### 2.1 Requisitos

| Herramienta | Versión |
|---|---|
| Node.js | ≥ 20 |
| pnpm | 9.15.0 (declarado en `packageManager`) |
| Docker | Para levantar Postgres/Redis locales en vez de usar la VPS |

### 2.2 Variables de entorno (`.env`)

| Variable | Usada en | Descripción | Default si falta |
|---|---|---|---|
| `DATABASE_URL` | `lib/database.ts` (vía Prisma) | Cadena de conexión Postgres | — (falla) |
| `REDIS_URL` | `lib/auth.ts` | Cadena de conexión Redis | — (falla) |
| `TRUSTED_ORIGINS` | `server.ts`, `lib/auth.ts` | Orígenes permitidos para CORS y Better Auth, separados por coma | `http://localhost:3000,http://localhost:3001` |
| `BETTER_AUTH_SECRET` | `lib/auth.ts` |   — |
| `BETTER_AUTH_URL` | `lib/auth.ts` | Base URL pública de la API para Better Auth | — |
| `GOOGLE_CLIENT_ID` | `lib/auth.ts` | OAuth Google | `""` |
| `GOOGLE_CLIENT_SECRET` | `lib/auth.ts` | OAuth Google | `""` |
| `GOOGLE_REDIRECT_URL` | `lib/auth.ts` | Callback OAuth Google | `http://localhost:4000/api/auth/callback/google` |
| `NODE_ENV` | `server.ts`, `lib/database.ts` | Nivel de logs de Fastify/Prisma | — |
| `PORT` | `server.ts` | Puerto donde escucha Fastify | `4000` |
| `POSTGRES_PASSWORD` | solo `docker-compose.yml` | Password del contenedor `db` | — |

### 2.3 Pasos para correr localmente

| Paso | Comando |
|---|---|
| 1. Clonar | `git clone https://github.com/group-blackpolar/CoreCrow-API.git` |
| 2. Instalar deps | `pnpm install` |
| 3. Crear `.env` | Copiar las variables de la tabla anterior |
| 4. Levantar Postgres/Redis | Con Docker local, o vía túnel SSH a la VPS (ver sección 6) |
| 5. Generar cliente Prisma | `pnpm db:generate` |
| 6. Aplicar schema | `pnpm db:push` (dev rápido) o `pnpm db:migrate` (con migración versionada) |
| 7. Crear admin inicial | `pnpm create-admin` (prompt interactivo) o `POST /api/admin/init` |
| 8. Correr en modo dev | `pnpm dev` (tsx watch, recarga automática) |
| 9. Build de producción | `pnpm build && pnpm start` |

### 2.4 Scripts disponibles (`package.json`)

| Script | Qué hace |
|---|---|
| `dev` | `tsx watch src/server.ts` — desarrollo con hot reload |
| `build` | `tsc` — compila a `dist/` |
| `start` | `node dist/server.js` — corre el build de producción |
| `lint` | `eslint src` |
| `create-admin` | Wizard interactivo para crear el primer usuario `ADMIN` |
| `db:generate` | `prisma generate` |
| `db:push` | `prisma db push` — sincroniza el schema sin migración formal |
| `db:migrate` | `prisma migrate dev` — crea y aplica migración en dev |
| `db:migrate:deploy` | `prisma migrate deploy` — aplica migraciones pendientes en producción |
| `db:studio` | `prisma studio` — UI visual de la base de datos |

---

## 3. Acceso con GitHub

| Ítem | Detalle |
|---|---|
| Repo | `group-blackpolar/CoreCrow-API`, público |
| Branch de deploy | `main` — cualquier push a `main` dispara el deploy automático |
| workflow secrets | `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` — generar en GitHub Secrets |

---

## 4. Cómo funcionan los deploys

Workflow: **"Deploy CoreClaw API"** (`.github/workflows/...`), dispara con `push` a `main` o manualmente (`workflow_dispatch`).

### 4.1 Flujo

| Paso | Acción |
|---|---|
| 1 | GitHub Actions se conecta por SSH al VPS usando `appleboy/ssh-action`, con `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` desde Secrets |
| 2 | `cd /var/www/corecrow-api` |
| 3 | `git fetch origin main` + `git reset --hard origin/main` — descarta cualquier cambio local no versionado en el VPS |
| 4 | `docker compose build --no-cache api` — reconstruye la imagen desde cero |
| 5 | `docker compose run --rm api npx prisma migrate deploy` — **aplica migraciones automáticamente antes del swap** |
| 6 | `docker compose down` → `docker compose up -d` — reinicia todos los servicios |
| 7 | `docker image prune -f` — limpia imágenes huérfanas |
| 8 | `docker compose ps` — confirma que los contenedores están arriba |

### 4.2 Consideraciones

- `--no-cache` en el build significa que cada deploy reconstruye todo desde cero (más lento, pero evita builds corruptos por cache stale).
- El `.env` real vive directamente en el VPS (`env_file: .env` en `docker-compose.yml`), no se inyecta desde GitHub Secrets — si cambias una variable, hay que editarla a mano en el servidor.
- Si `prisma migrate deploy` falla (por ejemplo por una migración con conflicto), el `set -e` del script corta el deploy ahí — no llega a hacer `down`/`up`, por lo que el contenedor viejo sigue corriendo hasta que se resuelva.

---

## 5. La API y su uso

### 5.1 Rutas registradas

| Prefijo | Plugin | Maneja |
|---|---|---|
| `/` | `healthRoutes` | Health check público |
| `/api/*` | `userRoutes` | Usuarios |
| `/api/*` | `authAdminRoutes` | Login de administradores |
| `/api/auth/*` | Better Auth handler | Login/registro/sesión de usuarios finales |

### 5.2 Endpoints

| Método | Ruta | Auth requerida | Descripción |
|---|---|---|---|
| `GET` | `/` | Ninguna | Redirige a `/health` |
| `GET` | `/health` | Ninguna | Página HTML pública con uptime, % de éxito y latencia de los últimos 30 días (ya implementado, con gráfico) |
| `GET` | `/api/users` | Ninguna todavía | Lista todos los usuarios (comentario en el código: *"agregar middleware de rol después"* — pendiente) |
| `GET` | `/api/users/:id` | Ninguna todavía | Detalle de un usuario |
| `POST` | `/api/admin/login` | Ninguna (es el login mismo) | Body `{ adminUniqueId }` → crea sesión de 24h si el rol es `ADMIN` |
| `POST` | `/api/admin/init` | Ninguna, pero solo funciona si **no existe ningún admin** | Crea el primer admin del sistema. El propio código marca que debería protegerse en producción |
| `GET` | `/api/admin/exists` | Ninguna | Devuelve si ya existe un admin (para que el frontend sepa si mostrar "setup inicial" o "login") |
| `ALL` | `/api/auth/*` | — | Delegado completo a Better Auth: login/registro por email+password, OAuth Google, manejo de sesión |

### 5.3 Middlewares existentes

| Archivo | Estado | Qué hace |
|---|---|---|
| `middlewares/authenticate.ts` | Implementado, no conectado a rutas | Acepta Bearer token (API key con hash SHA-256) **o** sesión de Better Auth; setea `req.apiKey` o `req.user` |
| `middlewares/authenticateAdmin.ts` | Implementado, no conectado a rutas | Valida sesión de admin (`Session` con `expiresAt` vigente) y rol `ADMIN`/`SUPERADMIN`; setea `req.admin` |
| `middlewares/audit.ts` | Implementado, no conectado a rutas | Factory `audit({ action, targetType, getTargetId })` que escribe en `AuditLog` tras una respuesta 2xx |
| `middlewares/requireRole.ts` | **Vacío (0 bytes)** | Pendiente de implementar |
| `middlewares/requireScope.ts` | **Vacío (0 bytes)** | Pendiente de implementar — para validar `scopes` de `ApiKey` |

### 5.5 Autenticación — separado para BP-Admin y UserClient

| Sistema | Para quién | Mecanismo | Expiración |
|---|---|---|---|
| Better Auth | Usuarios finales (registro público) | Cookie de sesión, email+password o Google OAuth, cacheado en Redis como `secondaryStorage` | 12h absolutas, se refresca cada 30 min de actividad (`updateAge`) |
| Sistema de `adminUniqueId` | Administradores (North) | `POST /api/admin/login` con el ID único → token de sesión propio (tabla `Session`) | 24h fijas, generado con `crypto.getRandomValues` |
| API Keys | Integraciones / North → CoreCrow-API | Bearer token, hash SHA-256 contra `ApiKey.keyHash`, con `scopes` | Definido por `expiresAt` al crearla (mencionaste 7 días fijos) |

---

## 6. Diseño de la base de datos (Prisma schema)

### 6.1 Tablas

| Modelo | Tabla real | Propósito |
|---|---|---|
| `User` | `users` | Usuarios (finales y admins, diferenciados por `role`) |
| `Session` | `sessions` | Sesiones activas (tanto de Better Auth como del login de admin) |
| `Account` | `accounts` | Cuentas OAuth/credenciales vinculadas (Better Auth) |
| `Verification` | `verifications` | Tokens de verificación de email (Better Auth) |
| `AuditLog` | *(sin `@@map`, tabla `AuditLog`)* | Registro de acciones administrativas |
| `ApiKey` | `api_keys` | Tokens de servicio con scopes |
| `UptimeCheck` | *(sin `@@map`, tabla `UptimeCheck`)* | Historial de checks de salud (usado por `/health`) |

### 6.2 `User`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `String` (cuid) | PK |
| `email` | `String` | único |
| `emailVerified` | `Boolean` | default `false` |
| `name` | `String?` | opcional |
| `image` | `String?` | opcional |
| `role` | `Role` enum | `USER \| DEVELOPER \| ADMIN \| SUPERADMIN`, default `USER` |
| `adminUniqueId` | `String?` | único, solo para admins |
| `createdAt` / `updatedAt` | `DateTime` | auto |

Relaciones: `sessions[]`, `accounts[]`, `apiKeys[]`

### 6.3 `Session`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `String` (cuid) | PK |
| `userId` | `String` | FK → `User`, `onDelete: Cascade` |
| `token` | `String` | único |
| `expiresAt` | `DateTime` | requerido |
| `ipAddress` / `userAgent` | `String?` | metadata de la sesión |
| `createdAt` | `DateTime` | auto |

### 6.4 `Account`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `String` (cuid) | PK |
| `userId` | `String` | FK → `User`, cascade |
| `accountId` / `providerId` | `String` | identifican el proveedor (ej. google) |
| `accessToken` / `refreshToken` | `String?` | tokens OAuth |
| `expiresAt` | `DateTime` | |
| `password` | `String?` | para el proveedor email/password |
| Único compuesto | `[providerId, accountId]` | |

### 6.5 `ApiKey`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `String` (cuid) | PK |
| `userId` | `String` | FK → `User`, cascade |
| `name` | `String` | etiqueta legible |
| `keyHash` | `String` | único, SHA-256 del token real (el token en claro nunca se guarda) |
| `prefix` | `String` | prefijo visible para identificar la key sin exponerla |
| `scopes` | `String[]` | permisos (ej. `logs:read`) |
| `lastUsed` | `DateTime?` | se actualiza en cada uso |
| `expiresAt` | `DateTime` | requerido |
| `revokedAt` | `DateTime?` | revocación manual |

### 6.6 `AuditLog`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `String` (cuid) | PK |
| `actorId` | `String?` | quién hizo la acción |
| `action` | `String` | ej. `"user.create"`, `"token.revoke"`, `"logs.view"` |
| `targetType` / `targetId` | `String?` | qué se afectó |
| `metadata` | `Json?` | incluye `apiKeyId` e `ip` cuando aplica |
| `createdAt` | `DateTime` | auto |

### 6.7 `UptimeCheck`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `String` (cuid) | PK |
| `checkedAt` | `DateTime` | indexado, cada 5 min via `startUptimeMonitor()` |
| `responseTimeMs` | `Int` | latencia del `SELECT 1` |
| `ok` | `Boolean` | si el check pasó |

---

## 7. Infraestructura y contenedores

| Contenedor | Imagen | Puerto | Notas |
|---|---|---|---|
| `corecrow-db` | `postgres:16-alpine` | `127.0.0.1:5432` | Volumen `pgdata`, healthcheck `pg_isready` |
| `corecrow-redis` | `redis:7-alpine` | Sin puerto expuesto | Solo accesible dentro de la red interna de Compose; volumen `redisdata` |
| `corecrow-api` | Build local (`Dockerfile` multi-stage) | `127.0.0.1:4000` | Depende de que `db` y `redis` estén `healthy` antes de arrancar |

Nginx en el host hace `proxy_pass` de `api.blackpolar.org` (443, con Certbot SSL) hacia `127.0.0.1:4000`.

**Dockerfile** — build multi-stage: `base` (Node 20 slim + openssl + corepack) → `deps` (pnpm install frozen) → `build` (prisma generate + tsc + prune prod) → `runtime` (copia solo `node_modules`, `dist`, `prisma`, `src/public`).

---
