# Node Hosting v1

Mini plataforma de deploy estilo Vercel/Render para `matecito.dev`, operando en un solo VPS y sin tocar `matebase-api`.

## Objetivo

Permitir que usuarios desplieguen apps Node compatibles con un runtime controlado por la plataforma:

- build reproducible
- ejecución aislada
- dominio/subdominio propio
- logs básicos
- variables de entorno
- integración con MatecitoDB vía API

No es un VPS administrado por el usuario. Es una plataforma de apps HTTP.

---

## Qué estamos construyendo

Arquitectura separada en 3 capas:

1. `matebase-api`
   - Sigue igual.
   - Provee auth, datos, storage, realtime, functions.

2. `matecito-deploy`
   - Servicio nuevo.
   - Administra apps, deployments, builds, estado, env vars y dominios.

3. `runtime`
   - Contenedores Docker por app.
   - Proxyados por Caddy.

---

## Qué tipo de apps soporta

Sólo `apps Node HTTP stateless`.

Requisitos mínimos:

- `package.json`
- comando de arranque (`npm start` o custom command)
- escuchar en `process.env.PORT`
- no depender de disco local persistente
- no requerir root ni acceso al host
- no requerir procesos auxiliares arbitrarios

Ejemplos válidos:

- Express
- Fastify
- NestJS
- Next.js SSR
- API backend
- paneles admin
- webhook handlers

Ejemplos no soportados en v1:

- Docker-in-Docker
- scraping pesado con Chromium
- ffmpeg intensivo
- workers agresivos de CPU
- procesos arbitrarios tipo daemon
- apps que requieran acceso SSH o al host

---

## Modelo de producto

Esto se parece más a `Render/Heroku` que a un VPS tradicional.

El usuario:

- sube repo o código fuente
- configura env vars
- elige comando de build/start
- obtiene dominio y logs

El usuario no:

- accede al host
- ejecuta comandos arbitrarios en producción
- administra Docker directamente
- accede al PostgreSQL interno de MatecitoDB

---

## Arquitectura v1

### Edge

`Caddy` termina TLS y enruta:

- `api.matecito.dev` -> `matebase-api`
- `*.apps.matecito.dev` -> `matecito-deploy` para resolución dinámica
- dominios custom -> `matecito-deploy`

### Control Plane

`matecito-deploy` expone APIs internas o panel para:

- crear app
- registrar repo
- disparar deployment
- guardar env vars
- listar logs
- consultar estado
- asignar dominio

La API del servicio debe salir versionada desde el día 1:

- `GET /api/hosting` -> metadata de versiones
- `.../api/hosting/v1/...` -> contrato estable actual

Así evitás romper el panel o el flujo de deploy cuando cambie el servicio.

### Build Plane

GitHub Actions es la única estrategia de build.

El VPS no construye imágenes.

El flujo es:

- GitHub Actions corre en GitHub
- builda la imagen
- la publica en un registry, idealmente `GHCR`
- llama al endpoint de release del hosting

### Runtime Plane

Cada deployment exitoso:

- crea contenedor nuevo
- inyecta env vars
- asigna puerto interno
- aplica límites de CPU/RAM
- ejecuta healthcheck
- si pasa, se promueve a activo

---

## Recursos del VPS

Host actual:

- `8 GB RAM`
- `4 vCPU`

Reparto inicial recomendado:

- `2 GB` reservados para SO, Postgres, Redis y Caddy
- `1.5 GB` para `matebase-api` + jobs
- `4 GB` aprox para apps de usuarios

Planes sugeridos para v1:

- `starter`
  - `256 MB RAM`
  - `0.25 vCPU`
- `basic`
  - `512 MB RAM`
  - `0.5 vCPU`
- `pro`
  - `1024 MB RAM`
  - `1 vCPU`

Esto obliga a controlar cupos. No conviene vender “apps ilimitadas”.

---

## Por qué Docker

No es la opción de rendimiento bruto máximo, pero sí la opción correcta para v1 por:

- aislamiento
- límites de recursos
- despliegues reproducibles
- rollback sencillo
- operación simple en un solo VPS

Alternativas:

- `systemd/pm2`: más liviano, menos seguro para multi-tenant
- `Firecracker`: mejor aislamiento, demasiada complejidad para v1

---

## Integración con MatecitoDB

Las apps deployadas se conectan a MatecitoDB vía API, no por acceso SQL directo.

Variables inyectadas por el runtime cuando la app está vinculada a un proyecto:

```env
MATECITO_APP_URL=https://miapp.apps.matecito.dev
MATECITO_PROJECT_URL=https://mi-proyecto.matecito.dev
MATECITO_API_URL=https://api.matecito.dev
MATECITO_API_VERSION=v2
MATECITO_ANON_KEY=...
MATECITO_PROJECT_ID=...
```

`MATECITO_SERVICE_KEY` no se inyecta automáticamente por seguridad. Si una app backend realmente lo necesita, se configura manualmente como env var privada.

Inicialización recomendada con SDK oficial:

```ts
import { createClient } from "matecitodb"

const db = createClient(process.env.MATECITO_PROJECT_URL, {
  apiKey: process.env.MATECITO_ANON_KEY,
  apiVersion: process.env.MATECITO_API_VERSION || "v2",
})
```

Alternativa REST directa:

```ts
const res = await fetch(
  `${process.env.MATECITO_PROJECT_URL}/api/v2/project/data/list-records?collection=posts`,
  {
    headers: {
      "x-matecito-key": process.env.MATECITO_ANON_KEY,
    },
  }
)
```

Reglas:

- `ANON_KEY` puede usarse en frontend o backend según el caso
- `SERVICE_KEY` sólo backend privado
- nunca exponer `SERVICE_KEY` al browser
- no entregar acceso directo al schema PostgreSQL interno

Beneficios:

- preserva auth, RLS y auditoría
- evita acoplar runtime con DB interna
- mantiene estable la arquitectura de `matebase-api`

---

## Flujo de deploy

1. Usuario crea una app.
2. Usuario conecta repo GitHub y branch.
3. Se crea un registro `deployment` en estado `queued`.
4. GitHub Actions construye la imagen y la publica.
5. GitHub Actions llama al endpoint de release con `imageTag` y `commitSha`.
6. El VPS hace `docker pull` de esa imagen.
7. Se ejecuta healthcheck.
8. Si pasa, se promueve a deployment activo.
9. Caddy o el router interno comienza a enviar tráfico a esa versión.
10. La versión anterior se apaga o queda breve tiempo para rollback.

---

## Restricciones del runtime

Cada contenedor debe correr con:

- usuario no root
- límites de memoria
- límites de CPU
- límite de procesos
- restart policy
- logs con rotación
- filesystem efímero
- `no-new-privileges`
- `cap-drop=ALL`
- usuario no root dentro del contenedor
- logs rotados

No habilitar:

- montajes sensibles del host
- acceso al socket Docker
- privilegios elevados
- puertos arbitrarios expuestos al exterior

Además:

- sólo repos `https://...` en v1
- un deployment por app a la vez
- timeouts duros de proxy y boot
- forwarding controlado de headers al upstream

---

## Build Strategy v1

Única estrategia soportada:

- `GitHub Actions` construye la imagen
- la imagen se publica en `GHCR` u otro registry compatible
- el hosting recibe `imageTag` ya buildado

Contrato:

- la imagen final debe arrancar escuchando en `PORT`
- el healthcheck por defecto es `/`
- el runtime del VPS sólo hace `pull + run + healthcheck`

---

## Dominios

Esquema sugerido:

- app interna: `nombre.apps.matecito.dev`
- proyecto BaaS: `proyecto.matecito.dev`

Conviene separar ambos espacios para que no colisionen.

Dominios custom:

- el usuario apunta DNS a tu VPS
- Caddy resuelve TLS
- `matecito-deploy` valida ownership y asigna dominio a la app

---

## Base de datos del nuevo servicio

Tablas mínimas del servicio `matecito-deploy`:

### `host_apps`

- `id`
- `workspace_id`
- `project_id`
- `name`
- `slug`
- `runtime`
- `repo_url`
- `branch`
- `build_command`
- `start_command`
- `root_dir`
- `plan`
- `desired_state`
- `active_deployment_id`
- `created_at`
- `updated_at`

### `host_deployments`

- `id`
- `app_id`
- `source_type`
- `commit_sha`
- `image_tag`
- `status`
- `build_logs`
- `runtime_logs_ref`
- `internal_port`
- `healthcheck_path`
- `started_at`
- `finished_at`
- `created_at`

### `host_domains`

- `id`
- `app_id`
- `domain`
- `kind`
- `status`
- `verified_at`
- `created_at`

### `host_env_vars`

- `id`
- `app_id`
- `key`
- `value_encrypted`
- `scope`
- `created_at`
- `updated_at`

---

## Endpoints del nuevo servicio

Endpoints iniciales sugeridos:

- `GET /api/hosting`
- `POST /api/hosting/v1/apps`
- `GET /api/hosting/v1/apps`
- `GET /api/hosting/v1/apps/:id`
- `PATCH /api/hosting/v1/apps/:id`
- `POST /api/hosting/v1/apps/:id/deploy`
- `GET /api/hosting/v1/apps/:id/deployments`
- `GET /api/hosting/v1/deployments/:id`
- `GET /api/hosting/v1/deployments/:id/logs`
- `GET /api/hosting/v1/apps/:id/connection`
- `POST /api/hosting/v1/apps/:id/domains`
- `GET /api/hosting/v1/apps/:id/domains`
- `PUT /api/hosting/v1/apps/:id/env/:key`
- `GET /api/hosting/v1/apps/:id/env`

Si querés cero acoplamiento con `matebase-api`, este servicio puede tener su propia DB y auth interna temporalmente. Más adelante puede federarse con la plataforma principal.

---

## Caddy

Como ya tenés Caddy en el VPS, es una ventaja. La idea es no reemplazarlo sino agregarle una capa nueva.

Patrón sugerido:

```caddyfile
api.matecito.dev {
    reverse_proxy 127.0.0.1:3001
}

*.apps.matecito.dev {
    reverse_proxy 127.0.0.1:4100
}
```

Luego `matecito-deploy` decide a qué contenedor interno enviar cada request según `Host`.

Dos opciones:

1. routing dinámico en Caddy con plugin o config generada
2. routing dinámico dentro de `matecito-deploy`

Para v1 conviene más la segunda. Es más simple de operar.

---

## Diferencia contra Vercel

Sí, conceptualmente estamos haciendo algo “tipo Vercel”, pero en una versión mucho más acotada:

- sólo Node
- sólo un VPS
- sin edge compute
- sin autoscaling real
- sin múltiples regiones
- sin preview environments masivos

Eso está bien. El objetivo es resolver deploys confiables, no replicar Vercel completo.

---

## Flujo desde matecito.dev

Si alguien sube su app desde `matecito.dev`, el flujo ideal sería:

1. En el dashboard crea una app de hosting.
2. Elige workspace y, opcionalmente, un proyecto Matecito a vincular.
3. Pega el repo Git y define branch/root dir/comandos.
4. El panel llama a `POST /api/hosting/v1/apps`.
5. El usuario dispara deploy.
6. El panel llama a `POST /api/hosting/v1/apps/:id/deploy`.
7. El builder clona, construye imagen y levanta contenedor.
8. Si la app estaba vinculada a un proyecto, el runtime le inyecta:
   - `MATECITO_PROJECT_URL`
   - `MATECITO_API_URL`
   - `MATECITO_API_VERSION`
   - `MATECITO_PROJECT_ID`
   - `MATECITO_ANON_KEY`
9. La app queda disponible en `nombre.apps.matecito.dev`.
10. Si el usuario quiere un dominio custom, lo agrega desde el panel y apunta DNS al VPS.

Desde el punto de vista del developer, se siente como:

- deploy desde el panel
- entorno Node administrado
- app conectada a su backend MatecitoDB sin configurar manualmente toda la conexión

---

## GitHub y Auto-Deploy

Para que la app se redeploye sólo cuando cambia una branch:

- la app guarda una `source config` GitHub
- se define `repo_owner`, `repo_name`, `branch`
- `auto_deploy = true`
- GitHub envía webhook `push`
- el servicio sólo encola deployment si:
  - el push corresponde a la branch configurada
  - el `commit_sha` cambió respecto del último visto

Endpoints útiles:

- `GET /api/hosting/v1/apps/:id/source`
- `PUT /api/hosting/v1/apps/:id/source/github`
- `POST /api/hosting/v1/apps/:id/source/deploy-token/rotate`
- `GET /api/hosting/v1/apps/:id/source/github-actions`
- `POST /api/hosting/github-actions/release`

La app sigue vinculada a un repo y una branch, pero el trigger real de release viene desde GitHub Actions.

GitHub Actions corre sólo cuando cambia la branch configurada por el usuario.

El workflow recomendado:

```yaml
on:
  push:
    branches: [main]
```

Cada deployment debe guardar:

- `commit_sha`
- `commit_message`
- `commit_author`
- `trigger_type`

Así el versionado real del deploy queda atado al commit exacto.

---

## Build Sin Otro VPS

Decisión tomada:

- el build sale completamente del VPS
- `GitHub Actions` es la única opción soportada

Flujo recomendado:

1. push a la branch configurada
2. GitHub Actions builda la imagen
3. GitHub Actions publica la imagen en `ghcr.io/...`
4. GitHub Actions llama `POST /api/hosting/github-actions/release`
5. el VPS hace `docker pull`
6. levanta el contenedor
7. healthcheck
8. promote

Ventaja principal:

- tu VPS queda reservado para `runtime + proxy + matecitodb + control plane`

Plantilla base de workflow:

- [matecito-deploy.github-actions.yml](/C:/Programacion/matebase/api/docs/matecito-deploy.github-actions.yml:1)

El dashboard también puede pedir la versión parametrizada por app en:

- `GET /api/hosting/v1/apps/:id/source/github-actions`

Eso devuelve:

- `releaseUrl`
- secrets requeridos
- `workflowYaml` listo para pegar en `.github/workflows/matecito-deploy.yml`

---

## Roadmap sugerido

### Fase 1

- registry de apps
- deployments manuales
- contenedor por app
- subdominio automático
- logs básicos
- env vars

### Fase 2

- dominios custom
- rollback
- healthchecks más robustos
- métricas por app
- límites por plan

### Fase 3

- build cache
- suspensión de apps inactivas
- preview deployments
- escalado horizontal futuro

---

## Decisiones cerradas para v1

- no tocar `matebase-api`
- apps conectan a MatecitoDB sólo por API
- usar Docker
- usar Caddy como edge
- separar subdominios de apps y proyectos
- soportar sólo apps Node HTTP stateless
