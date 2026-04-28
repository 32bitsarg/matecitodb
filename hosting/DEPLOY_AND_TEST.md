# Hosting Deploy And Test

Guia operativa para levantar el servicio de hosting junto a `matebase-api`, configurar Caddy y probar un deploy real con GitHub Actions.

## 1. Proceso nuevo en el VPS

Este repo ahora tiene dos procesos:

- `matebase-api` -> `node index.js`
- `matecito-hosting` -> `node hosting/server.js`

Scripts disponibles:

```bash
npm run hosting:start
npm run hosting:dev
```

Variables minimas para el servicio de hosting:

```env
JWT_SECRET=...
DOMAIN=matecito.dev
HOSTING_PORT=4100
HOSTING_DEPLOY_HOST=deploy.matecito.dev
HOSTING_APPS_SUBDOMAIN=apps.matecito.dev
HOSTING_MATECITO_API_VERSION=v2
DOCKER_BIN=docker
```

Opcionales recomendadas:

```env
HOSTING_MIN_PORT=4600
HOSTING_MAX_PORT=4999
HOSTING_PROXY_TIMEOUT_MS=60000
HOSTING_DEFAULT_HEALTHCHECK_PATH=/
HOSTING_DOCKER_NETWORK=
HOSTING_ENCRYPTION_KEY=...
HOSTING_RELEASE_RATE_LIMIT_WINDOW_MS=60000
HOSTING_RELEASE_RATE_LIMIT_MAX=20
HOSTING_GHCR_USERNAME=
HOSTING_GHCR_TOKEN=
HOSTING_GHCR_LOGIN_TTL_MS=1800000
HOSTING_CLEANUP_RETAIN_DEPLOYMENTS=3
```

## 2. GHCR en el VPS

El runtime hace `docker pull` de imágenes publicadas por GitHub Actions.

Si el paquete en `ghcr.io` es privado, el VPS necesita login previo:

```bash
docker login ghcr.io -u TU_USUARIO_GITHUB
```

Usar un token de GitHub con permiso `read:packages`.

Si querés login renovable controlado por el servicio, configurá:

```env
HOSTING_GHCR_USERNAME=tu-usuario
HOSTING_GHCR_TOKEN=tu-token-con-read-packages
```

El runtime renueva `docker login` automáticamente antes de `pull` cuando vence el TTL configurado.

## 3. Caddyfile

Agregar estos bloques a tu `Caddyfile` existente:

```caddyfile
api.matecito.dev {
    reverse_proxy 127.0.0.1:3001
}

deploy.matecito.dev {
    reverse_proxy 127.0.0.1:4100
}

*.apps.matecito.dev {
    reverse_proxy 127.0.0.1:4100
}
```

Notas:

- `deploy.matecito.dev` sirve la API del servicio de hosting
- `*.apps.matecito.dev` entra al router dinamico por `Host`
- `api.matecito.dev` sigue yendo a `matebase-api`

Aplicar cambios:

```bash
caddy validate --config /etc/caddy/Caddyfile
caddy reload --config /etc/caddy/Caddyfile
```

## 4. Arranque local en el VPS

Primero levantar `matebase-api`, luego `matecito-hosting`.

Chequeos basicos:

```bash
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:4100/health
curl https://deploy.matecito.dev/health
```

Esperado:

- `matebase-api` responde su health habitual
- `matecito-hosting` responde `{ ok: true, service: "matecito-hosting", api_version: "v1" }`

## 5. Configurar una app en el panel o por API

Secuencia:

1. crear app
2. vincular source GitHub
3. generar deploy token
4. pedir workflow parametrizado
5. agregar workflow al repo del usuario

Endpoints clave:

- `POST /api/hosting/v1/apps`
- `PUT /api/hosting/v1/apps/:appId/source/github`
- `POST /api/hosting/v1/apps/:appId/source/deploy-token/rotate`
- `GET /api/hosting/v1/apps/:appId/source/github-actions`

## 6. Secrets requeridos en GitHub

En el repo del usuario, crear:

- `MATECITO_HOSTING_RELEASE_URL`
- `MATECITO_HOSTING_DEPLOY_TOKEN`

Valores:

- `MATECITO_HOSTING_RELEASE_URL=https://deploy.matecito.dev/api/hosting/github-actions/release`
- `MATECITO_HOSTING_DEPLOY_TOKEN=<token generado para la app>`

## 7. Workflow en el repo del usuario

Usar la plantilla base:

- `docs/matecito-deploy.github-actions.yml`

O mejor:

- pedir `GET /api/hosting/v1/apps/:appId/source/github-actions`
- copiar `workflowYaml` en `.github/workflows/matecito-deploy.yml`

## 8. Prueba end-to-end

Prueba recomendada:

1. app Node minima que escuche en `PORT`
2. Dockerfile funcional
3. push a la branch configurada
4. GitHub Actions builda y sube imagen a `GHCR`
5. GitHub Actions llama al endpoint de release
6. el hosting hace `docker pull`
7. crea contenedor
8. pasa healthcheck
9. queda online en `https://<slug>.apps.matecito.dev`

## 9. Verificacion

Revisar:

- `GET /api/hosting/v1/apps/:appId/deployments`
- `GET /api/hosting/v1/deployments/:deploymentId/logs`
- `GET /api/hosting/v1/apps/:appId/events`

Probar la app:

```bash
curl -I https://tuapp.apps.matecito.dev/
```

Si la app esta vinculada a un proyecto Matecito, tambien revisar:

- `GET /api/hosting/v1/apps/:appId/connection`

## 10. Fallas comunes

### `docker pull` falla

- el VPS no tiene login a `ghcr.io`
- la imagen no existe
- el tag no coincide con `imageRepository`

### release rechazado

- `x-hosting-deploy-token` invalido
- branch distinta a la configurada
- `imageTag` fuera del repositorio permitido
- rate limit del endpoint de release

### app no levanta

- la imagen no escucha en `PORT`
- healthcheck incorrecto
- proceso muere al boot

### dominio no responde

- Caddy no tiene el bloque `*.apps.matecito.dev`
- el servicio de hosting no esta levantado
- el deployment no quedo `active`

## 11. Seguridad y operacion ya implementadas

- rate limit especifico para `github-actions/release`
- lock por `app_id` para impedir deploys simultaneos sobre la misma app
- limpieza automatica de contenedores e imagenes viejas
- validacion estricta de `imageTag` contra `imageRepository`
- login renovable a `GHCR` para pulls privados
- eventos persistidos de `release_accepted`, `deployment_failed`, `healthcheck_failed` y rate limit
